import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, writeFile, rm, chmod } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { HttpError } from './context.js';

export type SourceFiles = Record<string, string>;
export interface BuildResult { status: 'succeeded'|'failed'|'cancelled'; exitCode: number|null; logs: string; artifact?: Buffer; sha256?: string; }
const MAX_BYTES = 1024 * 1024, MAX_LOG_BYTES = 128 * 1024;
export function validateSourceFiles(files: SourceFiles) {
  const entries = Object.entries(files);
  if (!entries.length || entries.length > 100 || !files['index.html']) throw new HttpError(400,'Web build cần index.html và tối đa 100 tệp.');
  let bytes = 0;
  for (const [path, content] of entries) {
    if (typeof content !== 'string' || path.length > 160 || !/^[A-Za-z0-9_-][A-Za-z0-9_./-]*\.(?:html|css|js|mjs|cjs|json|txt|md)$/.test(path) || path.split('/').some(s=>!s || s==='.' || s==='..') || path.includes('node_modules')) throw new HttpError(400,'Đường dẫn/tệp nguồn không được hỗ trợ.');
    bytes += Buffer.byteLength(content);
  }
  if (bytes > MAX_BYTES) throw new HttpError(413,'Tổng mã nguồn vượt quá 1 MiB.');
}

// A small, deterministic ZIP writer. ZIP entries contain only prevalidated text;
// no shell, external unzip command, symlinks or absolute paths are involved.
function crc32(data: Buffer) { let crc=0xffffffff;for(const byte of data){crc^=byte;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return (crc^0xffffffff)>>>0; }
export function sourceZip(files: SourceFiles): Buffer {
  const parts: Buffer[] = [], directory: Buffer[] = []; let offset=0;
  for(const [path, text] of Object.entries(files).sort(([a],[b])=>a.localeCompare(b))) {
    const name=Buffer.from(path), data=Buffer.from(text), crc=crc32(data);
    const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt16LE(0x800,6);local.writeUInt32LE(crc,14);local.writeUInt32LE(data.length,18);local.writeUInt32LE(data.length,22);local.writeUInt16LE(name.length,26);
    const central=Buffer.alloc(46);central.writeUInt32LE(0x02014b50);central.writeUInt16LE(20,4);central.writeUInt16LE(20,6);central.writeUInt16LE(0x800,8);central.writeUInt32LE(crc,16);central.writeUInt32LE(data.length,20);central.writeUInt32LE(data.length,24);central.writeUInt16LE(name.length,28);central.writeUInt32LE(offset,42);
    parts.push(local,name,data);directory.push(central,name);offset+=local.length+name.length+data.length;
  }
  const central=Buffer.concat(directory), end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(Object.keys(files).length,8);end.writeUInt16LE(Object.keys(files).length,10);end.writeUInt32LE(central.length,12);end.writeUInt32LE(offset,16);
  return Buffer.concat([...parts,central,end]);
}

const runnerSource = `const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
function walk(p){return fs.readdirSync(p,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path.join(p,e.name)):[path.join(p,e.name)])}
const files=walk('/src');let tests=0;
for(const f of files.filter(f=>/\\.(?:js|mjs|cjs)$/.test(f))){console.log('SYNTAX',f.slice(5));let r=cp.spawnSync(process.execPath,['--check',f],{stdio:'inherit',timeout:3000});if(r.status!==0)process.exit(r.status||1)}
for(const f of files.filter(f=>/\\.test\\.(?:js|mjs|cjs)$/.test(f))){tests++;console.log('TEST',f.slice(5));let r=cp.spawnSync(process.execPath,[f],{stdio:'inherit',timeout:5000,cwd:'/tmp'});if(r.status!==0)process.exit(r.status||1)}
console.log('Verified '+files.length+' source files and executed '+tests+' test file(s).');`;

export function dockerAvailable(): Promise<boolean> {
  return new Promise(resolve=>{const p=spawn('docker',['info','--format','{{.ServerVersion}}'],{stdio:'ignore'});const timer=setTimeout(()=>{p.kill();resolve(false);},3000);p.on('error',()=>{clearTimeout(timer);resolve(false)});p.on('close',code=>{clearTimeout(timer);resolve(code===0)});});
}

export async function runWebBuild(options:{files:SourceFiles;workDir:string;signal?:AbortSignal;timeoutMs?:number;image?:string}):Promise<BuildResult> {
  validateSourceFiles(options.files);
  if (options.signal?.aborted) return {status:'cancelled',exitCode:null,logs:'Build đã được hủy trước khi chạy.'};
  const image=options.image||process.env.BUILD_RUNNER_IMAGE||'node:24-bookworm-slim';
  if(!/^[a-zA-Z0-9][a-zA-Z0-9_./:@-]+$/.test(image))throw new Error('Invalid runner image configuration');
  const name='pixel-build-'+randomUUID(),transfer=name+'-input',sourceVolume=name+'-source',controlVolume=name+'-control';
  const source=join(options.workDir,'source'),control=join(options.workDir,'control');
  await mkdir(source,{recursive:true,mode:0o755});await mkdir(control,{recursive:true,mode:0o755});
  await chmod(source,0o755);await chmod(control,0o755);
  for(const [path,text] of Object.entries(options.files)){
    await mkdir(dirname(join(source,path)),{recursive:true,mode:0o755});
    let parent=source;for(const segment of path.split('/').slice(0,-1)){parent=join(parent,segment);await chmod(parent,0o755);}
    await writeFile(join(source,path),text,{mode:0o644,flag:'wx'});await chmod(join(source,path),0o644);
  }
  await writeFile(join(control,'runner.cjs'),runnerSource,{mode:0o644,flag:'wx'});
  await chmod(join(control,'runner.cjs'),0o644);
  // Copy immutable input through the Docker API before starting. This works
  // with a remote daemon and never mounts host directories or the Docker socket
  // in the runner. The runtime root filesystem is entirely read-only.
  const args=['create','--rm','--pull=never','--name',name,'--network=none','--memory=256m','--memory-swap=256m','--cpus=1','--pids-limit=64','--read-only','--cap-drop=ALL','--security-opt=no-new-privileges','--user=65534:65534','--tmpfs','/tmp:rw,noexec,nosuid,size=64m,mode=1777','--mount',`type=volume,source=${sourceVolume},target=/src,readonly`,'--mount',`type=volume,source=${controlVolume},target=/runner,readonly`,'--env','NODE_ENV=test',image,'node','/runner/runner.cjs'];
  let logs='',timedOut=false,overflow=false,cancelled=false;
  const commandIgnore=(args:string[])=>new Promise<void>(resolve=>{const p=spawn('docker',args,{stdio:'ignore'});p.on('close',()=>resolve());p.on('error',()=>resolve());setTimeout(()=>{p.kill();resolve()},3000).unref();});
  const cleanup=()=>commandIgnore(['rm','-f',name]);
  try {
    const prepare=async(command:string[])=>new Promise<void>((resolve,reject)=>{const p=spawn('docker',command,{stdio:['ignore','pipe','pipe']});let error='';p.stderr.on('data',(b:Buffer)=>{error=(error+b.toString()).slice(0,3000)});const timeout=setTimeout(()=>p.kill('SIGTERM'),10000);p.on('error',e=>{clearTimeout(timeout);reject(e)});p.on('close',code=>{clearTimeout(timeout);code===0?resolve():reject(new Error('Docker preparation failed: '+error))});});
    // The transfer container is never started. Docker copies files into two
    // private volumes; the actual runner only receives read-only mounts.
    await prepare(['volume','create',sourceVolume]);await prepare(['volume','create',controlVolume]);
    await prepare(['create','--name',transfer,'--network=none','--mount',`type=volume,source=${sourceVolume},target=/src`,'--mount',`type=volume,source=${controlVolume},target=/runner`,image,'/bin/true']);
    await prepare(['cp',source+'/.',transfer+':/src']);await prepare(['cp',control+'/.',transfer+':/runner']);await prepare(args);
    if(options.signal?.aborted)return{status:'cancelled',exitCode:null,logs:'Build bị hủy trong khi chuẩn bị.'};
    const exitCode=await new Promise<number|null>(resolve=>{
      const child=spawn('docker',['start','--attach',name],{stdio:['ignore','pipe','pipe']});
      let settled=false;const finish=(code:number|null)=>{if(settled)return;settled=true;clearTimeout(timer);options.signal?.removeEventListener('abort',abort);resolve(code);};
      const abort=()=>{cancelled=true;void cleanup();child.kill('SIGTERM');};
      const timer=setTimeout(()=>{timedOut=true;void cleanup();child.kill('SIGTERM')},Math.min(options.timeoutMs||20000,60000));
      options.signal?.addEventListener('abort',abort,{once:true});
      const collect=(data:Buffer)=>{if(overflow)return;logs+=data.toString('utf8');if(Buffer.byteLength(logs)>MAX_LOG_BYTES){logs=Buffer.from(logs).subarray(0,MAX_LOG_BYTES).toString();overflow=true;void cleanup();child.kill('SIGTERM')}};
      child.stdout.on('data',collect);child.stderr.on('data',collect);
      child.on('error',error=>{logs+='\nDocker runner không khả dụng: '+error.message;finish(null)});child.on('close',finish);
      if(options.signal?.aborted)abort();
    });
    if(cancelled)return{status:'cancelled',exitCode,logs:logs+'\nBuild bị hủy.'};
    if(timedOut||overflow||exitCode!==0)return{status:'failed',exitCode,logs:logs+(timedOut?'\nRunner vượt quá thời gian.':overflow?'\nRunner vượt quá giới hạn log.':'')};
    const artifact=sourceZip(options.files);
    return{status:'succeeded',exitCode,logs,artifact,sha256:createHash('sha256').update(artifact).digest('hex')};
  } finally {await cleanup();await commandIgnore(['rm','-f',transfer]);await commandIgnore(['volume','rm',sourceVolume,controlVolume]);await rm(options.workDir,{recursive:true,force:true});}
}
