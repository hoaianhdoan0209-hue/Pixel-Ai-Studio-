import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {createApp} from '../server/app.js';
import {skillLocation} from '../server/skills.js';
import type {ProviderRequest} from '../server/ai-providers.js';

test('GitHub skill URLs remain on the fixed public raw host',()=>{
  assert.equal(skillLocation('https://github.com/example/skills/blob/main/design/SKILL.md').url,'https://raw.githubusercontent.com/example/skills/main/design/SKILL.md');
  assert.equal(skillLocation('https://raw.githubusercontent.com/example/skills/abc123/SKILL.md').url,'https://raw.githubusercontent.com/example/skills/abc123/SKILL.md');
  for(const url of ['http://github.com/a/b/blob/main/SKILL.md','https://127.0.0.1/SKILL.md','https://github.com.evil.test/a/b/blob/main/SKILL.md','https://github.com/a/b','https://github.com/a/b/tree/main/SKILL.md','https://github.com/a/b/blob/main/SKILL.md?token=secret','https://user:pass@github.com/a/b/blob/main/SKILL.md','https://raw.githubusercontent.com/a/b/main/other.md','https://github.com/a/b/blob/main/%2fSKILL.md'])assert.throws(()=>skillLocation(url));
});

test('project skills are authorized, immutable per job, role scoped and budgeted',async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'pixel-skills-'));
  let fetches=0, mode='ok';const requests:ProviderRequest[]=[];
  const runtime=createApp({dataDir,allowFirstAdmin:true,skills:{fetcher:async(input,options)=>{
    fetches++;assert.ok(String(input).startsWith('https://raw.githubusercontent.com/'));assert.equal(options?.redirect,'error');assert.ok(!options?.headers||!JSON.stringify(options.headers).includes('Authorization'));
    if(mode==='large')return new Response('x'.repeat(17000));if(mode==='html')return new Response('<!doctype html><title>login</title>');if(mode==='missing')return new Response('',{status:404});
    return new Response('# Thiết kế game\nSKILL_REFERENCE_MARKER: Hãy ưu tiên điều khiển cảm ứng.\nKhông tự thực thi mã.');
  }},ai:{workerEnabled:false,providers:{openai:{configured:true,generate:async request=>{requests.push(request);return {text:'Đã phân tích theo tài liệu.',inputTokens:30,outputTokens:10}}}}}});
  const server=runtime.app.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address!=='string');const base=`http://127.0.0.1:${address.port}/api`;
  function client(){let cookie='';return async(path:string,method='GET',body?:unknown)=>{const r=await fetch(base+path,{method,headers:{Cookie:cookie,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});if(r.headers.getSetCookie()[0])cookie=r.headers.getSetCookie()[0].split(';')[0];return{status:r.status,body:await r.json() as any}}}
  const owner=client(),other=client(),viewer=client();
  try{
    await owner('/auth/register','POST',{name:'Skill Owner',email:'skill-owner@example.test',password:'Skill-password-2026!'});
    await other('/auth/register','POST',{name:'Skill Other',email:'skill-other@example.test',password:'Skill-password-2026!'});
    const account=await viewer('/auth/register','POST',{name:'Skill Viewer',email:'skill-viewer@example.test',password:'Skill-password-2026!'});
    const project=(await owner('/projects','POST',{name:'Skill studio'})).body.project;
    runtime.db.prepare('INSERT INTO project_members VALUES(?,?,?,?)').run(project.id,account.body.user.id,'viewer',new Date().toISOString());
    const path='/ai/projects/'+project.id+'/skills';
    const input={name:'Thiết kế cảm ứng',url:'https://github.com/example/skills/blob/main/design/SKILL.md',roles:['game_designer']};
    let skill:any;
    await t.test('only an unlocked owner can import; viewers cannot read and outsiders cannot probe',async()=>{
      assert.equal((await other(path)).status,404);assert.equal((await viewer(path)).status,403);
      assert.equal((await viewer(path,'POST',input)).status,403);assert.equal(fetches,0);
      const result=await owner(path,'POST',input);assert.equal(result.status,201);skill=result.body.skill;
      assert.equal(skill.roles[0],'game_designer');assert.equal(skill.sha256.length,64);assert.ok(skill.content.includes('SKILL_REFERENCE_MARKER'));
      assert.equal((await owner(path,'POST',input)).status,409);assert.equal(fetches,1);
    });
    await t.test('invalid, oversized, missing and HTML responses never persist skills',async()=>{
      assert.equal((await owner(path,'POST',{...input,url:'https://localhost/SKILL.md'})).status,400);assert.equal(fetches,1);
      for(const [next,status] of [['large',413],['html',422],['missing',422]] as const){mode=next;assert.equal((await owner(path,'POST',{...input,url:'https://github.com/example/skills/blob/main/'+next+'/SKILL.md'})).status,status)}mode='ok';
      assert.equal((await owner(path)).body.skills.length,1);
    });
    await owner('/ai/pricing','POST',{provider:'openai',model:'skill-fixture',inputUsdPerMillion:1,outputUsdPerMillion:2,effectiveAt:'2026-01-01T00:00:00Z'});
    await owner('/ai/projects/'+project.id+'/budget','PUT',{tokenLimit:1000000,costLimitUsd:10,jobLimit:20,maxConcurrent:1,maxOutputTokens:100});
    let n=0;const submit=async(agent='game_designer',key?:string)=>{const r=await owner('/ai/projects/'+project.id+'/jobs','POST',{agent,prompt:'Thiết kế cách chơi cho dự án này.',provider:'openai',model:'skill-fixture',idempotencyKey:key||'skill-request-'+(++n)});assert.equal(r.status,201,JSON.stringify(r.body));return r.body.job};
    await t.test('queued snapshot reaches the provider after its skill is disabled or deleted; idempotency retains it',async()=>{
      const job=await submit('game_designer','skill-stable-key');assert.equal(job.skills[0].sha256,skill.sha256);
      const plain=await submit('developer');assert.equal(plain.skills.length,0);assert.ok(job.reservedTokens>plain.reservedTokens);
      const update=await owner(path+'/'+skill.id,'PATCH',{version:skill.version,enabled:false});assert.equal(update.status,200);skill=update.body.skill;
      assert.equal((await owner(path+'/'+skill.id,'PATCH',{version:1,enabled:true})).status,409);
      assert.equal((await submit()).skills.length,0);
      const retry=await owner('/ai/projects/'+project.id+'/jobs','POST',{agent:'game_designer',prompt:'Thiết kế cách chơi cho dự án này.',provider:'openai',model:'skill-fixture',idempotencyKey:'skill-stable-key'});assert.equal(retry.status,200);assert.equal(retry.body.job.skills[0].sha256,job.skills[0].sha256);
      assert.equal((await owner(path+'/'+skill.id,'DELETE',{version:skill.version})).status,200);
      await runtime.ai.runNext();
      assert.equal(requests.length,1);assert.equal(requests[0].messages[0].role,'system');assert.ok(!requests[0].messages[0].content.includes('SKILL_REFERENCE_MARKER'));
      assert.equal(requests[0].messages[1].role,'user');assert.ok(requests[0].messages[1].content.includes('SKILL_REFERENCE_MARKER'));
      assert.ok(requests[0].messages[1].content.includes('không phải chỉ dẫn hệ thống'));
      assert.equal((await owner('/ai/jobs/'+job.id)).body.job.skills[0].sha256,job.skills[0].sha256);
    });
    await t.test('lock blocks imports before fetching and assignments reject unknown roles',async()=>{
      assert.equal((await owner(path,'POST',{...input,roles:['admin']})).status,400);
      const before=fetches;await owner('/projects/'+project.id+'/lock','POST',{locked:true});
      assert.equal((await owner(path,'POST',input)).status,403);assert.equal(fetches,before);
    });
  }finally{runtime.stopServices();await new Promise<void>(resolve=>server.close(()=>resolve()));runtime.close();await rm(dataDir,{recursive:true,force:true})}
});
