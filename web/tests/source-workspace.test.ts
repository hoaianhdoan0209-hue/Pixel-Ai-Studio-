import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, stat, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../server/app.js';
import { sourceHash, validateWorkspaceFiles } from '../server/source-workspace.js';

test('authorized immutable source snapshots require real passing Docker validation before GitHub writes', {timeout:90000}, async t => {
  const dataDir=await mkdtemp(join(tmpdir(),'pixel-source-workspaces-'));
  const {privateKey}=generateKeyPairSync('rsa',{modulusLength:2048,privateKeyEncoding:{type:'pkcs8',format:'pem'},publicKeyEncoding:{type:'spki',format:'pem'}});
  const baseCommit='a'.repeat(40),treeSha='b'.repeat(40);
  let remoteCommit=baseCommit,badBlob=false,symlink=false,truncated=false,omitTests=false,lockOnCommit=false;
  const sourceFiles={
    'index.html':'<!doctype html><title>Verified source</title><script src="game.js"></script>',
    'game.js':'module.exports = {answer:1};',
    'game.test.js':"const assert=require('node:assert/strict');assert.equal(require('/src/game.js').answer,2);console.log('SOURCE_PIPELINE_ACTUAL');",
    '.env.json':'{"PRIVATE_TEST_FIXTURE":"must-not-import"}',
  };
  const blobs=Object.entries(sourceFiles).map(([path,content])=>({path,content,type:'blob',mode:'100644',size:Buffer.byteLength(content),sha:createHash('sha1').update(`blob ${Buffer.byteLength(content)}\0`).update(content).digest('hex')}));
  const calls:Array<{path:string;method:string;body:any}>=[];
  let runtime:ReturnType<typeof createApp>;
  let projectId='',ownerId='',otherId='';
  const fetcher=async(url:string,init:RequestInit)=>{
    assert.ok(url.startsWith('https://api.github.com/'));assert.equal(init.redirect,'error');
    const path=new URL(url).pathname,method=init.method||'GET',body=init.body?JSON.parse(String(init.body)):null;
    calls.push({path,method,body});let result:any;
    if(path==='/app/installations/42')result={id:42,account:{login:'workspace-fixture'},suspended_at:null};
    else if(path.endsWith('/access_tokens'))result={token:'explicit-test-installation-token',expires_at:new Date(Date.now()+3600000).toISOString()};
    else if(path==='/repos/acme/realm')result={full_name:'acme/realm',default_branch:'main',permissions:{push:true}};
    else if(path.endsWith('/git/ref/heads/main'))result={object:{sha:remoteCommit}};
    else if(path.endsWith('/git/commits/'+baseCommit)){
      if(lockOnCommit){runtime.db.prepare('UPDATE projects SET locked=1 WHERE id=?').run(projectId);lockOnCommit=false;}
      result={tree:{sha:treeSha}};
    }
    else if(path.endsWith('/git/trees/'+treeSha))result={tree:[...blobs.filter(b=>!omitTests||!b.path.endsWith('.test.js')),...(symlink?[{path:'link.js',mode:'120000',type:'blob',sha:'c'.repeat(40),size:3}]:[])],truncated};
    else if(path.includes('/git/blobs/')){const blob=blobs.find(b=>path.endsWith(b.sha));if(!blob)return new Response('{}',{status:404});result={encoding:'base64',content:Buffer.from(badBlob?'corrupted':blob.content).toString('base64')};}
    else if(path.endsWith('/git/trees')&&method==='POST')result={sha:'d'.repeat(40)};
    else if(path.endsWith('/git/commits')&&method==='POST')result={sha:'e'.repeat(40)};
    else if(path.endsWith('/git/refs')&&method==='POST')result={ref:body.ref};
    else if(path.endsWith('/pulls')&&method==='POST')result={number:1,html_url:'https://github.com/acme/realm/pull/1'};
    else return new Response('{}',{status:404});
    return new Response(JSON.stringify(result),{status:200,headers:{'Content-Type':'application/json'}});
  };
  runtime=createApp({dataDir,allowFirstAdmin:true,integrations:{runnerEnabled:true,github:{appId:'123',privateKey,encryptionKey:randomBytes(32).toString('hex'),fetcher}}});
  const server=runtime.app.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address!=='string');
  const base=`http://127.0.0.1:${address.port}/api`;
  function client(){let cookie='';return async(path:string,method='GET',body?:unknown)=>{const r=await fetch(base+path,{method,headers:{...(cookie?{Cookie:cookie}:{}),...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});const c=r.headers.getSetCookie()[0];if(c)cookie=c.split(';')[0];return{status:r.status,body:await r.json()};};}
  const owner=client(),other=client();
  const writes=()=>calls.filter(c=>c.method==='POST'&&!c.path.endsWith('/access_tokens'));
  async function proposal(branch:string,workspaceId:string,answer=2){return owner(`/projects/${projectId}/repository/proposals`,'POST',{branch,base:'main',title:'Reviewed source change',body:'Explicit test fixture proposal',workspaceId,files:[{path:'game.js',content:`module.exports = {answer:${answer}};`}]});}
  async function waitBuild(id:string){for(let i=0;i<200;i++){const b=(await owner(`/projects/${projectId}/builds/${id}`)).body.build;if(['succeeded','failed','cancelled'].includes(b.status))return b;await new Promise(r=>setTimeout(r,100));}throw new Error('Actual Docker validation did not finish');}
  let workspaceId='',successfulProposal='';
  try{
    ownerId=(await owner('/auth/register','POST',{name:'Workspace owner',email:'workspace-owner@example.test',password:'Workspace-test-password!'})).body.user.id;
    otherId=(await other('/auth/register','POST',{name:'Workspace outsider',email:'workspace-other@example.test',password:'Workspace-test-password!'})).body.user.id;
    projectId=(await owner('/projects','POST',{name:'Workspace project',visibility:'private'})).body.project.id;
    const connection=(await owner('/github/connections','POST',{installationId:'42',userId:ownerId})).body.connection;
    assert.equal((await owner(`/projects/${projectId}/repository`,'POST',{connectionId:connection.id,owner:'acme',repository:'realm',branch:'main'})).status,200);
    await t.test('snapshot verifies Git blob SHA and excludes private configuration without reading it',async()=>{
      const created=await owner(`/projects/${projectId}/workspaces`,'POST',{source:'github',base:'main'});assert.equal(created.status,201,JSON.stringify(created.body));
      const w=created.body.workspace;workspaceId=w.id;assert.equal(w.baseCommit,baseCommit);assert.equal(w.fileCount,3);assert.ok(w.excludedPaths.includes('.env.json'));
      const detail=await owner(`/projects/${projectId}/workspaces/${workspaceId}`);assert.equal(detail.body.files['game.js'],sourceFiles['game.js']);assert.equal(detail.body.files['.env.json'],undefined);assert.equal(w.manifestHash,sourceHash(detail.body.files));
      const privateBlob=blobs.find(b=>b.path==='.env.json')!;assert.ok(!calls.some(c=>c.path.endsWith(privateBlob.sha)));
      assert.equal((await stat(join(dataDir,'workspaces',workspaceId,'manifest.json'))).mode&0o777,0o600);
      assert.equal((await other(`/projects/${projectId}/workspaces`)).status,404);
      assert.equal((await other(`/projects/${projectId}/workspaces/${workspaceId}`)).status,404);
    });
    await t.test('bad blob checksums, symlinks and truncated trees never persist a snapshot',async()=>{
      const before=runtime.db.prepare('SELECT COUNT(*) AS n FROM source_workspaces').get()!.n;
      badBlob=true;assert.equal((await owner(`/projects/${projectId}/workspaces`,'POST',{source:'github'})).status,502);badBlob=false;
      symlink=true;assert.equal((await owner(`/projects/${projectId}/workspaces`,'POST',{source:'github'})).status,400);symlink=false;
      truncated=true;assert.equal((await owner(`/projects/${projectId}/workspaces`,'POST',{source:'github'})).status,413);truncated=false;
      assert.equal(runtime.db.prepare('SELECT COUNT(*) AS n FROM source_workspaces').get()!.n,before);
      for(const path of ['../escape.js','.env.json','secret.pem','node_modules/a.js'])assert.throws(()=>validateWorkspaceFiles({[path]:'x'}));
    });
    await t.test('invalid or mismatched workspace proposal is atomic and zero-test validation is refused',async()=>{
      const before=runtime.db.prepare('SELECT COUNT(*) AS n FROM github_proposals').get()!.n;
      assert.equal((await proposal('pixel/missing',randomUUID())).status,404);
      const local=await owner(`/projects/${projectId}/workspaces`,'POST',{source:'local',files:{'index.html':'<!doctype html>'}});assert.equal(local.status,201);
      assert.equal((await proposal('pixel/local',local.body.workspace.id)).status,409);
      assert.equal(runtime.db.prepare('SELECT COUNT(*) AS n FROM github_proposals').get()!.n,before);
      omitTests=true;const noTests=await owner(`/projects/${projectId}/workspaces`,'POST',{source:'github'});omitTests=false;assert.equal(noTests.status,201);
      const noTestProposal=await proposal('pixel/no-tests',noTests.body.workspace.id);assert.equal(noTestProposal.status,201);
      const buildsBefore=runtime.db.prepare('SELECT COUNT(*) AS n FROM build_jobs').get()!.n;
      const rejected=await owner(`/projects/${projectId}/repository/proposals/${noTestProposal.body.proposal.id}/validate`,'POST',{});assert.equal(rejected.status,409);assert.equal(rejected.body.code,'TESTS_REQUIRED');assert.equal(runtime.db.prepare('SELECT COUNT(*) AS n FROM build_jobs').get()!.n,buildsBefore);
    });
    await t.test('real failing tests cannot authorize a PR or create any GitHub write',async()=>{
      const p=await proposal('pixel/failing',workspaceId,3);assert.equal(p.status,201);const id=p.body.proposal.id;
      assert.equal((await owner(`/projects/${projectId}/repository/proposals/${id}/approve`,'POST',{})).body.code,'VALIDATION_REQUIRED');
      const validation=await owner(`/projects/${projectId}/repository/proposals/${id}/validate`,'POST',{});assert.equal(validation.status,202,JSON.stringify(validation.body));
      const build=await waitBuild(validation.body.build.id);assert.equal(build.status,'failed');assert.notEqual(build.exitCode,0);assert.equal(build.artifact,null);
      const count=writes().length;const approval=await owner(`/projects/${projectId}/repository/proposals/${id}/approve`,'POST',{});assert.equal(approval.status,409);assert.equal(approval.body.code,'VALIDATION_FAILED');assert.equal(writes().length,count);
    });
    await t.test('actual changed code passes Docker tests, then only owner approval creates a new branch and PR',async()=>{
      const p=await proposal('pixel/validated',workspaceId);assert.equal(p.status,201);successfulProposal=p.body.proposal.id;
      const validation=await owner(`/projects/${projectId}/repository/proposals/${successfulProposal}/validate`,'POST',{});assert.equal(validation.status,202,JSON.stringify(validation.body));
      const build=await waitBuild(validation.body.build.id);assert.equal(build.status,'succeeded');assert.equal(build.exitCode,0);assert.ok(build.logs.includes('SOURCE_PIPELINE_ACTUAL'));assert.ok(build.logs.includes('TEST game.test.js'));
      const count=writes().length;assert.equal((await other(`/projects/${projectId}/repository/proposals/${successfulProposal}/approve`,'POST',{})).status,404);assert.equal(writes().length,count);
      const savedBuild=runtime.db.prepare('SELECT artifact_path FROM build_jobs WHERE id=?').get(validation.body.build.id)!;
      const originalArtifact=await readFile(String(savedBuild.artifact_path));
      try{
        await writeFile(String(savedBuild.artifact_path),Buffer.from('corrupted artifact'));
        const invalidArtifact=await owner(`/projects/${projectId}/repository/proposals/${successfulProposal}/approve`,'POST',{});assert.equal(invalidArtifact.status,409);assert.equal(invalidArtifact.body.code,'VALIDATION_FAILED');assert.equal(writes().length,count);
      }finally{await writeFile(String(savedBuild.artifact_path),originalArtifact);}
      const originalChange=runtime.db.prepare('SELECT files_json FROM github_proposals WHERE id=?').get(successfulProposal)!.files_json;
      try{
        runtime.db.prepare('UPDATE github_proposals SET files_json=? WHERE id=?').run(JSON.stringify([{path:'game.js',content:'module.exports={answer:999};'}]),successfulProposal);
        const invalidSource=await owner(`/projects/${projectId}/repository/proposals/${successfulProposal}/approve`,'POST',{});assert.equal(invalidSource.status,409);assert.equal(invalidSource.body.code,'VALIDATION_STALE');assert.equal(writes().length,count);
      }finally{runtime.db.prepare('UPDATE github_proposals SET files_json=? WHERE id=?').run(originalChange,successfulProposal);}

      remoteCommit='f'.repeat(40);const stale=await owner(`/projects/${projectId}/repository/proposals/${successfulProposal}/approve`,'POST',{});assert.equal(stale.status,409);assert.equal(stale.body.code,'BASE_CHANGED');assert.equal(writes().length,count);remoteCommit=baseCommit;
      lockOnCommit=true;const revoked=await owner(`/projects/${projectId}/repository/proposals/${successfulProposal}/approve`,'POST',{});assert.equal(revoked.status,403);assert.equal(writes().length,count);runtime.db.prepare('UPDATE projects SET locked=0 WHERE id=?').run(projectId);
      // A failed action is not retried: fresh proposal and fresh real validation are required.
      assert.equal((await owner(`/projects/${projectId}/repository/proposals/${successfulProposal}/approve`,'POST',{})).status,409);
      const fresh=await proposal('pixel/validated-final',workspaceId);successfulProposal=fresh.body.proposal.id;
      const newValidation=await owner(`/projects/${projectId}/repository/proposals/${successfulProposal}/validate`,'POST',{});assert.equal(newValidation.status,202);assert.equal((await waitBuild(newValidation.body.build.id)).status,'succeeded');
      const concurrent=await Promise.all([owner(`/projects/${projectId}/repository/proposals/${successfulProposal}/approve`,'POST',{}),owner(`/projects/${projectId}/repository/proposals/${successfulProposal}/approve`,'POST',{})]);
      assert.deepEqual(concurrent.map(x=>x.status).sort(),[200,409]);assert.equal(concurrent.find(x=>x.status===200)!.body.proposal.status,'succeeded');
      const refs=writes().filter(c=>c.path.endsWith('/git/refs'));assert.equal(refs.length,1);assert.equal(refs[0].body.ref,'refs/heads/pixel/validated-final');assert.ok(!calls.some(c=>['PATCH','PUT'].includes(c.method)));
      const after=writes().length;assert.equal((await owner(`/projects/${projectId}/repository/proposals/${successfulProposal}/approve`,'POST',{})).status,409);assert.equal(writes().length,after);
    });
    await t.test('approved action bridges are owner-only, immutable and idempotent with real Docker work',async()=>{
      const files={'index.html':'<!doctype html><title>Approved tool action</title>','check.test.js':"require('node:assert/strict').equal(2+2,4);console.log('APPROVED_BRIDGE_ACTUAL');"};
      const action={id:randomUUID(),projectId,type:'request_build' as const,arguments:{version:'ai-approved',files}};
      await assert.rejects(runtime.integrations.enqueueApprovedBuild(action,otherId),/quyền/);
      const first=await runtime.integrations.enqueueApprovedBuild(action,ownerId),second=await runtime.integrations.enqueueApprovedBuild(action,ownerId);assert.equal((first.build as any).id,(second.build as any).id);
      await assert.rejects(runtime.integrations.enqueueApprovedBuild({...action,arguments:{...action.arguments,files:{...files,'extra.js':'0'}}},ownerId),/khác/);
      const result=await waitBuild((first.build as any).id);assert.equal(result.status,'succeeded');assert.ok(result.logs.includes('APPROVED_BRIDGE_ACTUAL'));
      const proposalAction={id:randomUUID(),projectId,type:'propose_source_change' as const,arguments:{branch:'pixel/tool-proposal',base:'main',title:'Reviewed tool proposal',body:'Not yet remote writes',workspaceId,files:{'game.js':'module.exports={answer:2};'}}};
      const count=writes().length;const one=await runtime.integrations.enqueueSourceProposal(proposalAction,ownerId),two=await runtime.integrations.enqueueSourceProposal(proposalAction,ownerId);assert.equal((one.proposal as any).id,(two.proposal as any).id);assert.equal(writes().length,count);
      await assert.rejects(runtime.integrations.enqueueSourceProposal({...proposalAction,arguments:{...proposalAction.arguments,title:'Changed intent'}},ownerId),/khác/);
      runtime.db.prepare('UPDATE projects SET locked=1 WHERE id=?').run(projectId);
      await assert.rejects(runtime.integrations.enqueueSourceProposal({...proposalAction,id:randomUUID()},ownerId),/quyền/);
      // Revocation is independently checked, including an owner whose membership changed.
      runtime.db.prepare("UPDATE project_members SET role='viewer' WHERE project_id=? AND user_id=?").run(projectId,ownerId);
      await assert.rejects(runtime.integrations.enqueueSourceProposal({...proposalAction,id:randomUUID()},ownerId),/quyền/);
      runtime.db.prepare("UPDATE project_members SET role='owner' WHERE project_id=? AND user_id=?").run(projectId,ownerId);runtime.db.prepare('UPDATE projects SET locked=0 WHERE id=?').run(projectId);
    });
    await t.test('source-only retained snapshots block permanent purge without an unrelated AI or build record',async()=>{
      const retained=(await owner('/projects','POST',{name:'Retained source only'})).body.project;
      const snapshot=await owner(`/projects/${retained.id}/workspaces`,'POST',{source:'local',files:{'index.html':'<!doctype html><title>Retained</title>'}});assert.equal(snapshot.status,201);
      assert.equal((await owner(`/projects/${retained.id}`,'DELETE')).status,200);
      runtime.db.prepare('UPDATE projects SET deleted_at=? WHERE id=?').run(new Date(Date.now()-8*86400000).toISOString(),retained.id);
      const trashed=runtime.db.prepare('SELECT name,version FROM projects WHERE id=?').get(retained.id)!;
      const purge=await owner(`/projects/${retained.id}/permanent`,'DELETE',{version:trashed.version,confirmation:trashed.name,confirmPermanent:true});
      assert.equal(purge.status,409);assert.equal(purge.body.code,'RETENTION_POLICY');assert.equal(runtime.db.prepare('SELECT COUNT(*) AS n FROM source_workspaces WHERE project_id=?').get(retained.id)!.n,1);
    });
    assert.deepEqual(runtime.db.prepare('PRAGMA foreign_key_check').all(),[]);
  }finally{
    await new Promise<void>(resolve=>server.close(()=>resolve()));runtime.close();await rm(dataDir,{recursive:true,force:true});
  }
});
