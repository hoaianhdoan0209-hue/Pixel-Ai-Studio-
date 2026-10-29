import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { createApp } from '../server/app.js';
import { assemblePreview } from '../server/preview.js';

test('preview assembly inlines only immutable local source and removes browser escape markup', () => {
  const html = assemblePreview({
    'index.html': '<!doctype html><meta http-equiv="refresh" content="0;url=https://example.invalid"><link rel="dns-prefetch" href="//example.invalid"><base href="https://example.invalid"><link rel="stylesheet" href="style.css"><script src="game.js"></script><iframe src="https://example.invalid"></iframe><a href="https://example.invalid" target="_top">link</a>',
    'style.css': 'body{color:green}', 'game.js': 'document.body.dataset.ready="yes";',
  });
  assert.ok(html.includes('body{color:green}'));
  assert.ok(html.includes('document.body.dataset.ready'));
  assert.ok(!html.includes('example.invalid'));
  assert.ok(!html.includes('<iframe'));
  assert.throws(() => assemblePreview({'index.html': '<script src="https://example.invalid/x.js"></script>'}), /script/);
  assert.throws(() => assemblePreview({'index.html': '<link rel="stylesheet" href="missing.css">'}), /stylesheet/);
  assert.throws(() => assemblePreview({'index.html': '<div>'.repeat(150) + 'deep' + '</div>'.repeat(150)}), /độ sâu/);
});

test('authenticated one-use preview and real Chromium isolation protect the application', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pixel-preview-'));
  let time = Date.now();
  const runtime = createApp({dataDir: directory, preview: {clock: () => time, ttlMs: 1000}, ai: {workerEnabled: false}});
  const server = runtime.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const cookieJar = new Map<string, string>();
  const call = async (client: string, path: string, method = 'GET', body?: unknown, extra: Record<string, string> = {}) => {
    const response = await fetch(base + path, {method, headers: {
      ...(cookieJar.get(client) ? {Cookie: cookieJar.get(client)!} : {}),
      ...(body === undefined ? {} : {'Content-Type': 'application/json'}), ...extra,
    }, ...(body === undefined ? {} : {body: JSON.stringify(body)})});
    const cookie = response.headers.getSetCookie()[0]; if (cookie) cookieJar.set(client, cookie.split(';')[0]);
    const text = await response.text();
    return {status: response.status, headers: response.headers, text, body: response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : null};
  };
  const owner = (await call('owner', '/api/auth/register', 'POST', {name: 'Preview Owner', email: 'preview-owner@example.test', password: 'Preview-password-2026!'})).body.user;
  await call('other', '/api/auth/register', 'POST', {name: 'Preview Other', email: 'preview-other@example.test', password: 'Preview-password-2026!'});
  const project = (await call('owner', '/api/projects', 'POST', {name: 'Isolated preview project'})).body.project;
  const buildId = randomUUID();
  const files = {'index.html': '<!doctype html><link rel="stylesheet" href="game.css"><button id="increment">Increment</button><output id="count">0</output><script src="game.js"></script>', 'game.css': 'body{background:rgb(240,240,230)}', 'game.js': 'document.querySelector("#increment").onclick=()=>{document.querySelector("#count").textContent=String(Number(document.querySelector("#count").textContent)+1)};'};
  runtime.db.prepare("INSERT INTO build_jobs(id,project_id,author_id,target,version,status,files_json,created_at) VALUES(?,?,?,'web','fixture','succeeded',?,?)").run(buildId, project.id, owner.id, JSON.stringify(files), new Date().toISOString());
  const path = `/api/projects/${project.id}/builds/${buildId}/preview`;
  let trapRequests = 0;
  const trap = createServer((_req, res) => {trapRequests++; res.end('This server must never receive preview requests.');});
  trap.listen(0, '127.0.0.1'); await once(trap, 'listening');
  const trapAddress = trap.address(); assert.ok(trapAddress && typeof trapAddress !== 'string');
  const trapOrigin = `http://127.0.0.1:${trapAddress.port}`;
  runtime.app.get('/__preview_parent', (_req, res) => res.type('html').send('<!doctype html><title>Trusted preview harness</title><main id="private">Private parent</main>'));
  runtime.app.get('/__trusted_navigation', (_req, res) => res.type('html').send('<!doctype html><script>parent.document.body.dataset.compromised="yes"</script>'));
  try {
    await t.test('unauthenticated, wrong project and failed builds cannot obtain launch capabilities', async () => {
      assert.equal((await call('guest', path, 'POST', {})).status, 401);
      assert.equal((await call('other', path, 'POST', {})).status, 404);
      runtime.db.prepare("UPDATE build_jobs SET status='failed' WHERE id=?").run(buildId);
      assert.equal((await call('owner', path, 'POST', {})).status, 409);
      runtime.db.prepare("UPDATE build_jobs SET status='succeeded' WHERE id=?").run(buildId);
    });
    await t.test('top-level requests are refused, launch binds the session, and iframe capability is single-use', async () => {
      const result = await call('owner', path, 'POST', {}); assert.equal(result.status, 201);
      const preview = result.body.preview;
      assert.equal((await call('owner', preview.url)).status, 403);
      const metadata = {'Sec-Fetch-Dest': 'iframe', 'Sec-Fetch-Site': 'same-origin'};
      assert.equal((await call('other', preview.url, 'GET', undefined, metadata)).status, 404);
      const page = await call('owner', preview.url, 'GET', undefined, metadata);
      assert.equal(page.status, 200);
      assert.match(page.headers.get('content-security-policy')!, /sandbox allow-scripts/);
      assert.match(page.headers.get('content-security-policy')!, /connect-src 'none'/);
      assert.ok(!page.headers.get('content-security-policy')!.includes('allow-same-origin'));
      assert.equal(page.headers.get('cache-control'), 'no-store');
      assert.match(page.headers.get('permissions-policy')!, /camera=\(\)/);
      assert.equal((await call('owner', preview.url, 'GET', undefined, metadata)).status, 410);
      assert.equal((await call('owner', preview.statusUrl)).body.preview.launched, true);
      await call('owner', `${path}/${preview.id}`, 'DELETE');
    });
    await t.test('expiry, revocation and immutable source changes disable new launches', async () => {
      const expired = (await call('owner', path, 'POST', {})).body.preview;
      time += 1500;
      assert.equal((await call('owner', expired.statusUrl)).body.preview.reason, 'expired');
      const changed = (await call('owner', path, 'POST', {})).body.preview;
      runtime.db.prepare('UPDATE build_jobs SET files_json=? WHERE id=?').run(JSON.stringify({...files, 'game.css': 'body{color:red}'}), buildId);
      assert.equal((await call('owner', changed.statusUrl)).body.preview.reason, 'revoked');
      runtime.db.prepare('UPDATE build_jobs SET files_json=? WHERE id=?').run(JSON.stringify(files), buildId);
      await call('owner', `${path}/${changed.id}`, 'DELETE');
    });
    await t.test('live membership and session revocation disable existing capabilities', async () => {
      const preview = (await call('owner', path, 'POST', {})).body.preview;
      runtime.db.prepare('DELETE FROM project_members WHERE project_id=? AND user_id=?').run(project.id, owner.id);
      const status = await call('owner', preview.statusUrl);
      assert.equal(status.body.preview.active, false);
      assert.equal(status.body.preview.reason, 'revoked');
      runtime.db.prepare('INSERT INTO project_members VALUES(?,?,?,?)').run(project.id, owner.id, 'owner', new Date().toISOString());
      await call('owner', `${path}/${preview.id}`, 'DELETE');
      const sessionPreview = (await call('owner', path, 'POST', {})).body.preview;
      runtime.db.prepare('DELETE FROM sessions WHERE user_id=?').run(owner.id);
      assert.equal((await call('owner', sessionPreview.statusUrl)).status, 401);
      assert.equal((await call('owner', sessionPreview.url, 'GET', undefined, {'Sec-Fetch-Dest': 'iframe', 'Sec-Fetch-Site': 'same-origin'})).status, 404);
    });
    await t.test('real Chromium executes the game but cannot escape the opaque sandbox even without an iframe attribute', async () => {
      const script = String.raw`
import json,os,time
from playwright.sync_api import sync_playwright,expect
base=os.environ['PREVIEW_TEST_BASE'];path=os.environ['PREVIEW_TEST_PATH'];trap=os.environ['PREVIEW_TEST_TRAP']
with sync_playwright() as p:
 b=p.chromium.launch(executable_path=os.environ.get('CHROMIUM_EXECUTABLE','/usr/bin/chromium'),headless=True,args=['--no-sandbox'])
 context=b.new_context()
 response=context.request.post(base+'/api/auth/login',data={'email':'preview-owner@example.test','password':'Preview-password-2026!'})
 assert response.status==200
 page=context.new_page();page.goto(base+'/__preview_parent')
 page.evaluate("document.cookie='preview_parent_sentinel=not_for_preview; path=/';localStorage.setItem('preview_secret','not_for_preview')")
 preview=context.request.post(base+path,data={}).json()['preview']
 page.evaluate('(url)=>{let f=document.createElement("iframe");f.id="game";f.src=url;document.body.appendChild(f)}',preview['url'])
 frame=page.frame_locator('#game')
 expect(frame.locator('#count')).to_have_text('0');frame.get_by_role('button',name='Increment').click();expect(frame.locator('#count')).to_have_text('1')
 f=page.locator('#game').element_handle().content_frame()
 results=f.evaluate('''async(trap)=>{
  const results={};for(const [name,fn] of Object.entries({parent:()=>parent.document.querySelector('#private').textContent,cookie:()=>document.cookie,storage:()=>localStorage.getItem('preview_secret')})){try{fn();results[name]='allowed'}catch{results[name]='blocked'}}
  try{await fetch(trap+'/fetch');results.fetch='allowed'}catch{results.fetch='blocked'}
  results.worker=await new Promise(resolve=>{try{const worker=new Worker(URL.createObjectURL(new Blob(['postMessage(1)'],{type:'text/javascript'})));worker.onmessage=()=>{worker.terminate();resolve('allowed')};worker.onerror=event=>{event.preventDefault();worker.terminate();resolve('blocked')};setTimeout(()=>{worker.terminate();resolve('unknown')},1000)}catch{resolve('blocked')}})
  results.popup=window.open(trap+'/popup')===null?'blocked':'allowed';
  const img=new Image();img.src=trap+'/image';document.body.appendChild(img);
  const form=document.createElement('form');form.action=trap+'/form';form.method='POST';document.body.appendChild(form);form.submit();
  return results;
 }''',trap)
 assert all(v=='blocked' for v in results.values()),results
 # Main trusted HTML refuses frame embedding even if preview's iframe attr was removed.
 try:f.evaluate("location.href='/__trusted_navigation'")
 except Exception:pass
 page.wait_for_timeout(300)
 assert page.locator('body').get_attribute('data-compromised') is None
 # A fresh launch also proves remote self-navigation is blocked by parent frame-src.
 preview2=context.request.post(base+path,data={}).json()['preview']
 page.evaluate('(url)=>{document.querySelector("#game").remove();let f=document.createElement("iframe");f.id="game";f.src=url;document.body.appendChild(f)}',preview2['url'])
 expect(page.frame_locator('#game').locator('#count')).to_have_text('0')
 f=page.locator('#game').element_handle().content_frame()
 try:f.evaluate('(url)=>{location.href=url}',trap+'/navigate')
 except Exception:pass
 page.wait_for_timeout(300)
 direct=page.goto(base+preview2['url']);assert direct.status==403
 context.close();b.close()
print('Real browser gameplay, opaque origin, storage/cookie/parent/network/worker/popup/form/navigation isolation passed.')
`;
      const child = spawn('python3', ['-c', script], {env: {...process.env, PREVIEW_TEST_BASE: base, PREVIEW_TEST_PATH: path, PREVIEW_TEST_TRAP: trapOrigin}, stdio: ['ignore', 'pipe', 'pipe']});
      let output = ''; child.stdout.on('data', data => {output += data;}); child.stderr.on('data', data => {output += data;});
      const timeout = setTimeout(() => child.kill('SIGKILL'), 30000);
      const [code] = await once(child, 'exit'); clearTimeout(timeout);
      assert.equal(code, 0, output.slice(-4000));
      assert.equal(trapRequests, 0, 'Untrusted preview sent a network request.');
    });
  } finally {
    await new Promise<void>(resolve => trap.close(() => resolve()));
    runtime.stopServices();
    await new Promise<void>(resolve => server.close(() => resolve()));
    runtime.close();
    await rm(directory, {recursive: true, force: true});
  }
});
