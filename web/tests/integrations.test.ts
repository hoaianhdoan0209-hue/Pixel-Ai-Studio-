import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHash, createHmac, generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Server } from 'node:http';
import { createApp } from '../server/app.js';
import { encryptToken, decryptToken, verifyWebhook } from '../server/github.js';
import { sourceZip } from '../server/build-runner.js';

test('GitHub App contracts, approval and artifact authorization use real persisted state',async(t)=>{
  const root=await mkdtemp(join(tmpdir(),'pixel-integrations-test-'));
  const key=randomBytes(32).toString('hex');
  const {privateKey}=generateKeyPairSync('rsa',{modulusLength:2048,privateKeyEncoding:{type:'pkcs8',format:'pem'},publicKeyEncoding:{type:'spki',format:'pem'}});
  const baseSha='a'.repeat(40),treeSha='b'.repeat(40);
  const snapshotFiles={'index.html':'<!doctype html><title>Fixture</title>','game.js':'console.log(0)','game.test.js':"require('node:assert/strict').equal(1+1,2);"};
  const blobs=Object.entries(snapshotFiles).map(([path,content])=>{const data=Buffer.from(content);return{path,content,sha:createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex'),size:data.length,type:'blob',mode:'100644'};});
  const calls:Array<{path:string;method:string;body:any;authorization:string}>=[];
  const fetcher=async(url:string,init:RequestInit)=>{
    assert.ok(url.startsWith('https://api.github.com/'),'tokens only go to GitHub HTTPS');assert.equal(init.redirect,'error');
    const path=new URL(url).pathname,method=init.method||'GET',body=init.body?JSON.parse(String(init.body)):null;
    calls.push({path,method,body,authorization:(init.headers as Record<string,string>).Authorization});
    let data:any;
    if(path==='/app/installations/42')data={id:42,account:{login:'pixel-fixture'},suspended_at:null};
    else if(path==='/app/installations/42/access_tokens')data={token:'fixture-installation-secret',expires_at:new Date(Date.now()+3600000).toISOString()};
    else if(path==='/repos/acme/realm')data={full_name:'acme/realm',default_branch:'main',permissions:{push:true}};
    else if(path.endsWith('/git/ref/heads/main'))data={object:{sha:baseSha}};
    else if(path.endsWith('/git/commits/'+baseSha))data={tree:{sha:treeSha}};
    else if(path.endsWith('/git/trees/'+treeSha))data={tree:blobs,truncated:false};
    else if(path.includes('/git/blobs/')){const blob=blobs.find(b=>path.endsWith(b.sha));if(!blob)return new Response('{}',{status:404});data={encoding:'base64',content:Buffer.from(blob.content).toString('base64')};}
    else if(path.endsWith('/git/trees'))data=method==='POST'?{sha:'changed-tree'}:{tree:[]};
    else if(path.endsWith('/git/commits'))data={sha:'new-commit'};
    else if(path.endsWith('/git/refs'))data={ref:body.ref};
    else if(path.endsWith('/pulls'))data=method==='POST'?{number:1,html_url:'https://github.com/acme/realm/pull/1'}:[];
    else if(path.endsWith('/commits'))data=[];
    else return new Response(JSON.stringify({message:'not found'}),{status:404});
    return new Response(JSON.stringify(data),{status:200,headers:{'Content-Type':'application/json'}});
  };
  let runtime:ReturnType<typeof createApp>,server:Server,base='';
  async function start(){runtime=createApp({dataDir:root,allowFirstAdmin:true,integrations:{github:{appId:'123',privateKey,encryptionKey:key,webhookSecret:'fixture-webhook-secret',fetcher},runBuild:async({files,signal})=>{if(files['wait.test.js'])await new Promise<void>(resolve=>{const timer=setTimeout(resolve,3000);signal?.addEventListener('abort',()=>{clearTimeout(timer);resolve()},{once:true});});const artifact=sourceZip(files);return{status:'succeeded',exitCode:0,logs:'explicit injected contract runner; Docker tested separately',artifact,sha256:createHash('sha256').update(artifact).digest('hex')}}}});server=runtime.app.listen(0,'127.0.0.1');await once(server,'listening');const a=server.address();assert.ok(a&&typeof a!=='string');base=`http://127.0.0.1:${a.port}`;}
  async function stop(){if(server?.listening)await new Promise<void>(resolve=>server.close(()=>resolve()));runtime?.close();}
  function client(){let cookie='';return async(path:string,method='GET',body?:unknown)=>{const r=await fetch(base+'/api'+path,{method,headers:{...(cookie?{Cookie:cookie}:{}),...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});const c=r.headers.getSetCookie()[0];if(c)cookie=c.split(';')[0];const bytes=Buffer.from(await r.arrayBuffer());return{status:r.status,body:r.headers.get('content-type')?.includes('application/json')?JSON.parse(bytes.toString()):bytes,headers:r.headers};};}
  const owner=client(),other=client(),guest=client();let ownerId='',otherId='',projectId='',connectionId='',proposalId='',buildId='';
  try {
    await start();ownerId=(await owner('/auth/register','POST',{name:'Integration owner',email:'integrations-owner@example.test',password:'Integration-password-42!'})).body.user.id;
    otherId=(await other('/auth/register','POST',{name:'Integration other',email:'integrations-other@example.test',password:'Integration-password-42!'})).body.user.id;
    projectId=(await owner('/projects','POST',{name:'Integration project',visibility:'private'})).body.project.id;
    await t.test('encrypted token envelopes authenticate data and reject tampering',()=>{
      const encrypted=encryptToken('private-token',key);assert.ok(!encrypted.includes('private-token'));assert.equal(decryptToken(encrypted,key),'private-token');
      const parts=encrypted.split('.');const body=Buffer.from(parts[2],'base64url');body[0]^=1;parts[2]=body.toString('base64url');assert.throws(()=>decryptToken(parts.join('.'),key));
      assert.equal(verifyWebhook(Buffer.from('{}'),'sha256='+'0'.repeat(64),'secret'),false);
    });
    await t.test('only admin can grant an actual installation and token is never returned or stored in plaintext',async()=>{
      assert.equal((await other('/github/connections','POST',{installationId:'42',userId:otherId})).status,403);
      const result=await owner('/github/connections','POST',{installationId:'42',userId:ownerId});assert.equal(result.status,201,JSON.stringify(result.body));connectionId=result.body.connection.id;
      assert.equal(calls[0].authorization.split('.').length,3,'app authenticates with signed JWT');
      assert.deepEqual((await other('/github/connections')).body.connections,[]);
      const link=await owner(`/projects/${projectId}/repository`,'POST',{connectionId,owner:'acme',repository:'realm',branch:'main'});assert.equal(link.status,200,JSON.stringify(link.body));
      const saved=runtime.db.prepare('SELECT encrypted_token FROM github_connections WHERE id=?').get(connectionId)!;assert.ok(saved.encrypted_token);assert.ok(!String(saved.encrypted_token).includes('fixture-installation-secret'));
      assert.ok(!JSON.stringify(result.body).includes('fixture-installation-secret'));
      assert.equal((await other(`/projects/${projectId}/repository`)).status,404);
    });
    await t.test('code changes remain a proposal until owner approval, never update main or existing refs',async()=>{
      const before=calls.filter(c=>c.method==='POST').length;
      const snapshot=await owner(`/projects/${projectId}/workspaces`,'POST',{source:'github',base:'main'});assert.equal(snapshot.status,201,JSON.stringify(snapshot.body));
      const result=await owner(`/projects/${projectId}/repository/proposals`,'POST',{branch:'pixel/new-feature',base:'main',workspaceId:snapshot.body.workspace.id,title:'Add verified game file',body:'Approved fixture change',files:[{path:'game.js',content:'console.log(1)'}]});assert.equal(result.status,201,JSON.stringify(result.body));proposalId=result.body.proposal.id;
      assert.equal(calls.filter(c=>c.method==='POST').length,before,'proposal performs no GitHub writes');
      assert.equal((await other(`/projects/${projectId}/repository/proposals/${proposalId}/approve`,'POST',{})).status,404);
      const blocked=await owner(`/projects/${projectId}/repository/proposals/${proposalId}/approve`,'POST',{});assert.equal(blocked.status,409);assert.equal(blocked.body.code,'VALIDATION_REQUIRED');
      const validation=await owner(`/projects/${projectId}/repository/proposals/${proposalId}/validate`,'POST',{});assert.equal(validation.status,202,JSON.stringify(validation.body));
      for(let i=0;i<60;i++){if((await owner(`/projects/${projectId}/builds/${validation.body.build.id}`)).body.build.status==='succeeded')break;await new Promise(r=>setTimeout(r,20));}
      const approved=await owner(`/projects/${projectId}/repository/proposals/${proposalId}/approve`,'POST',{});assert.equal(approved.status,200,JSON.stringify(approved.body));assert.equal(approved.body.proposal.status,'succeeded');
      const refs=calls.filter(c=>c.path.endsWith('/git/refs'));assert.equal(refs.length,1);assert.equal(refs[0].body.ref,'refs/heads/pixel/new-feature');assert.ok(!calls.some(c=>c.method==='PATCH'||c.method==='PUT'));
      assert.equal((await owner(`/projects/${projectId}/repository/proposals/${proposalId}/approve`,'POST',{})).status,409,'approval never repeats external writes');
      assert.equal((await owner(`/projects/${projectId}/repository/proposals`,'POST',{branch:'main',base:'main',title:'Bad default update',body:'',files:[{path:'game.js',content:'x'}]})).status,400);
    });
    await t.test('signed webhook delivery is idempotent and bad signatures do not mutate state',async()=>{
      const payload=JSON.stringify({installation:{id:42},repository:{full_name:'acme/realm'}}),signature='sha256='+createHmac('sha256','fixture-webhook-secret').update(payload).digest('hex');
      async function webhook(sig:string){const r=await fetch(base+'/api/github/webhook',{method:'POST',headers:{'Content-Type':'application/json','X-GitHub-Delivery':'delivery-test-1','X-GitHub-Event':'push','X-Hub-Signature-256':sig},body:payload});return{status:r.status,body:await r.json()};}
      assert.equal((await webhook('sha256='+'0'.repeat(64))).status,401);const first=await webhook(signature);assert.equal(first.status,200,JSON.stringify(first.body));assert.equal(first.body.duplicate,false);assert.equal((await webhook(signature)).body.duplicate,true);
      assert.equal(runtime.db.prepare('SELECT COUNT(*) AS n FROM github_webhooks').get()!.n,1);
    });
    await t.test('build jobs create downloadable immutable ZIPs and deny private artifact access',async()=>{
      const created=await owner(`/projects/${projectId}/builds`,'POST',{target:'web',version:'0.1.0',files:{'index.html':'<!doctype html><title>Build</title>','game.js':'console.log(1)'}});assert.equal(created.status,202,JSON.stringify(created.body));buildId=created.body.build.id;
      let detail:any;
      for(let i=0;i<60;i++){detail=await owner(`/projects/${projectId}/builds/${buildId}`);if(detail.body.build.status==='succeeded')break;await new Promise(r=>setTimeout(r,20));}
      assert.equal(detail.body.build.status,'succeeded');assert.match(detail.body.build.artifact.sha256,/^[a-f0-9]{64}$/);
      const artifact=await owner(`/projects/${projectId}/builds/${buildId}/artifact`);assert.equal(artifact.status,200);assert.ok(artifact.headers.get('content-disposition')?.startsWith('attachment'));assert.equal(artifact.body.readUInt32LE(0),0x04034b50);assert.equal(createHash('sha256').update(artifact.body).digest('hex'),detail.body.build.artifact.sha256);
      assert.equal((await other(`/projects/${projectId}/builds/${buildId}/artifact`)).status,404);assert.equal((await guest(`/projects/${projectId}/builds/${buildId}/artifact`)).status,404);
      assert.equal((await owner(`/projects/${projectId}/releases`,'POST',{buildId,version:'0.1.0',changelog:'Ready',published:true})).status,409,'private project cannot publish code implicitly');
    });
    await t.test('cancellation wins a runner completion race without saving successful artifacts',async()=>{
      const created=await owner(`/projects/${projectId}/builds`,'POST',{target:'web',version:'0.2.0',files:{'index.html':'<!doctype html>','wait.test.js':'// explicit contract test wait'}});assert.equal(created.status,202);const id=created.body.build.id;
      for(let i=0;i<60;i++){if((await owner(`/projects/${projectId}/builds/${id}`)).body.build.status==='testing')break;await new Promise(r=>setTimeout(r,10));}
      assert.equal((await owner(`/projects/${projectId}/builds/${id}/cancel`,'POST',{})).status,200);
      let job:any;for(let i=0;i<60;i++){job=(await owner(`/projects/${projectId}/builds/${id}`)).body.build;if(job.status==='cancelled')break;await new Promise(r=>setTimeout(r,10));}
      assert.equal(job.status,'cancelled');assert.equal(job.artifact,null);assert.equal((await owner(`/projects/${projectId}/builds/${id}/artifact`)).status,404);
    });
    await t.test('membership alone cannot reveal source or artifacts without the role capability',async()=>{
      runtime.db.prepare('INSERT INTO project_members(project_id,user_id,role,joined_at) VALUES(?,?,?,?)').run(projectId,otherId,'viewer',new Date().toISOString());
      assert.equal((await other(`/projects/${projectId}/repository`)).status,403);
      assert.equal((await other(`/projects/${projectId}/builds/${buildId}/artifact`)).status,403);
      assert.equal((await other(`/projects/${projectId}/builds`,'POST',{target:'web',version:'bad',files:{'index.html':'x'}})).status,403);
    });
    await t.test('owner-approved public releases permit ZIP download without granting repository access',async()=>{
      const p=(await owner(`/projects/${projectId}`)).body.project;
      assert.equal((await owner(`/projects/${projectId}`,'PATCH',{version:p.version,visibility:'public'})).status,200);
      const release=await owner(`/projects/${projectId}/releases`,'POST',{buildId,version:'0.1.0',changelog:'Explicit public release',published:true});assert.equal(release.status,201);
      assert.equal((await guest(`/projects/${projectId}/builds/${buildId}/artifact`)).status,200);
      assert.equal((await other(`/projects/${projectId}/repository`)).status,403);
    });
    await t.test('restart preserves GitHub, webhook and build evidence without issuing external writes',async()=>{
      const before=calls.length;await stop();await start();assert.equal(calls.length,before);const saved=(await owner(`/projects/${projectId}/repository`)).body;assert.equal(saved.proposals[0].status,'succeeded');assert.equal((await owner(`/projects/${projectId}/builds/${buildId}`)).body.build.status,'succeeded');
    });
  }finally{await stop();await rm(root,{recursive:true,force:true});}
});

test('unconfigured external services fail clearly without sending credentials or fabricating jobs',async()=>{
  const dataDir=await mkdtemp(join(tmpdir(),'pixel-integrations-unconfigured-'));
  const runtime=createApp({dataDir,allowFirstAdmin:true,integrations:{runnerEnabled:false,github:{appId:'',privateKey:'',encryptionKey:'',webhookSecret:'',fetcher:async()=>{throw new Error('Unconfigured service must not issue requests')}}}});
  const server=runtime.app.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address!=='string');const base=`http://127.0.0.1:${address.port}`;
  try{
    const account=await fetch(base+'/api/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'Unconfigured admin',email:'unconfigured@example.test',password:'Unconfigured-password-42!'})});assert.equal(account.status,201);const user=(await account.json()).user,cookie=account.headers.getSetCookie()[0].split(';')[0];
    const headers={Cookie:cookie,'Content-Type':'application/json'};
    const project=await fetch(base+'/api/projects',{method:'POST',headers,body:JSON.stringify({name:'Unconfigured project'})});const projectId=(await project.json()).project.id;
    const state=await(await fetch(base+'/api/integrations',{headers})).json();assert.equal(state.github.connected,false);assert.equal(state.build.connected,false);
    assert.equal((await fetch(base+'/api/github/connections',{method:'POST',headers,body:JSON.stringify({installationId:'42',userId:user.id})})).status,503);
    assert.equal((await fetch(base+`/api/projects/${projectId}/builds`,{method:'POST',headers,body:JSON.stringify({target:'web',version:'1',files:{'index.html':'x'}})})).status,503);
    assert.equal(runtime.db.prepare('SELECT COUNT(*) AS n FROM build_jobs').get()!.n,0);assert.equal(runtime.db.prepare('SELECT COUNT(*) AS n FROM github_connections').get()!.n,0);
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));runtime.close();await rm(dataDir,{recursive:true,force:true});}
});
