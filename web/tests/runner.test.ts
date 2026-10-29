import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { dockerAvailable, runWebBuild, validateSourceFiles } from '../server/build-runner.js';

test('real Docker static-web runner creates verified artifacts and isolates untrusted tests',async(t)=>{
  assert.equal(await dockerAvailable(),true,'Required Docker engine is available in this environment');
  const root=await mkdtemp(join(tmpdir(),'pixel-runner-test-'));
  try {
    await t.test('source validation rejects traversal, unsupported targets and excessive content',()=>{
      assert.throws(()=>validateSourceFiles({'index.html':'ok','../escape.js':'bad'}));
      assert.throws(()=>validateSourceFiles({'index.html':'ok','malware.exe':'bad'}));
      assert.throws(()=>validateSourceFiles({'index.html':'x'.repeat(1024*1024+1)}));
      assert.throws(()=>validateSourceFiles({'file.js':'console.log(1)'}));
    });
    await t.test('actual tests run without host secrets, network, writable source, or Docker socket',async()=>{
      const sentinel=join(root,'host-secret.txt');await writeFile(sentinel,'HOST-PRIVATE-SENTINEL');
      const source={
        'index.html':'<!doctype html><title>Build fixture</title><script src="game.js"></script>',
        'game.js':'globalThis.gameReady=true;',
        'sandbox.test.js':`const assert=require('node:assert/strict'),fs=require('node:fs'),net=require('node:net');
assert.equal(process.env.AI_API_KEY,undefined);assert.equal(process.env.GH_APP_PRIVATE_KEY,undefined);
assert.equal(fs.existsSync('/var/run/docker.sock'),false);assert.equal(fs.existsSync(${JSON.stringify(sentinel)}),false);
assert.throws(()=>fs.writeFileSync('/src/index.html','MUTATED'));assert.throws(()=>fs.writeFileSync('/etc/pixel-untrusted','MUTATED'));
const socket=net.createConnection({host:'1.1.1.1',port:443});socket.on('connect',()=>{console.error('NETWORK WAS AVAILABLE');process.exit(1)});socket.on('error',()=>{console.log('sandbox assertions passed');socket.destroy()});setTimeout(()=>socket.destroy(),700).unref();`,
      };
      const result=await runWebBuild({files:source,workDir:join(root,'success')});
      assert.equal(result.status,'succeeded',result.logs);assert.equal(result.exitCode,0);
      assert.match(result.logs,/sandbox assertions passed/);assert.match(result.logs,/executed 1 test file/);
      assert.ok(result.artifact);assert.equal(result.artifact.readUInt32LE(0),0x04034b50);
      assert.equal(result.sha256,createHash('sha256').update(result.artifact).digest('hex'));
    });
    await t.test('syntax and assertion failures cannot produce a successful artifact',async()=>{
      const syntax=await runWebBuild({files:{'index.html':'<!doctype html>','game.js':'const broken = ;'},workDir:join(root,'syntax')});
      assert.equal(syntax.status,'failed');assert.equal(syntax.artifact,undefined);assert.notEqual(syntax.exitCode,0);assert.match(syntax.logs,/SyntaxError/);
      const assertion=await runWebBuild({files:{'index.html':'<!doctype html>','game.test.js':"require('node:assert/strict').equal(1,2)"},workDir:join(root,'assertion')});
      assert.equal(assertion.status,'failed');assert.equal(assertion.artifact,undefined);assert.match(assertion.logs,/AssertionError/);
    });
    await t.test('wall-clock timeouts terminate the container and record failure',async()=>{
      const result=await runWebBuild({files:{'index.html':'<!doctype html>','loop.test.js':'setInterval(()=>{},10)'},workDir:join(root,'timeout'),timeoutMs:1500});
      assert.equal(result.status,'failed');assert.equal(result.artifact,undefined);assert.match(result.logs,/thời gian/);
    });
    await t.test('cancellation never creates an artifact',async()=>{
      const controller=new AbortController();controller.abort();
      const result=await runWebBuild({files:{'index.html':'<!doctype html>'},workDir:join(root,'cancelled'),signal:controller.signal});
      assert.equal(result.status,'cancelled');assert.equal(result.artifact,undefined);
    });
  } finally {await rm(root,{recursive:true,force:true});}
});
