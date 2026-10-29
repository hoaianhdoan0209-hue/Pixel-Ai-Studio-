import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import http, { type ClientRequest, type IncomingMessage } from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const webRoot = fileURLToPath(new URL('../', import.meta.url));

async function deadline<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

async function freePort() {
  const reservation = net.createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = (reservation.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
  return port;
}

interface RunningServer {
  child: ChildProcess;
  base: string;
  logs: () => string;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

async function launch(dataDir: string): Promise<RunningServer> {
  const port = await freePort();
  // This subprocess needs no provider, SMTP, GitHub or inherited application secrets.
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    cwd: webRoot,
    env: {
      PATH: process.env.PATH,
      PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir,
      NODE_ENV: 'test', MAIL_MODE: 'disabled', REQUIRE_VERIFIED_EMAIL: 'true',
      BUILD_RUNNER_ENABLED: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const capture = (chunk: Buffer) => { output = (output + chunk.toString('utf8')).slice(-65536); };
  child.stdout!.on('data', capture);
  child.stderr!.on('data', capture);
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  return { child, base: `http://127.0.0.1:${port}`, logs: () => output, exited };
}

function jsonRequest(server: RunningServer, path: string, method = 'GET', body?: unknown, cookie?: string): Promise<{ status: number; body: any; cookie: string }> {
  return new Promise((resolve, reject) => {
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    const request = http.request(server.base + path, {
      method,
      headers: {
        Connection: 'close',
        ...(encoded ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(encoded) } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
      },
    }, response => {
      const chunks: Buffer[] = [];
      let length = 0;
      response.on('data', (chunk: Buffer) => {
        length += chunk.length;
        if (length > 256 * 1024) { request.destroy(new Error('Unexpectedly large test response.')); return; }
        chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => {
        try {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: response.statusCode || 0, body: text ? JSON.parse(text) : null, cookie: response.headers['set-cookie']?.[0]?.split(';')[0] || '' });
        } catch (error) { reject(error); }
      });
    });
    request.once('error', reject);
    request.setTimeout(1500, () => request.destroy(new Error('Test HTTP request timed out.')));
    request.end(encoded);
  });
}

async function ready(server: RunningServer) {
  const readiness = (async () => {
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        const result = await jsonRequest(server, '/api/health');
        if (result.status === 200 && result.body.status === 'ok') return;
      } catch { /* The child has not finished loading its modules yet. */ }
      await delay(40);
    }
    throw new Error('Isolated server did not become ready.');
  })();
  await deadline(Promise.race([
    readiness,
    server.exited.then(exit => { throw new Error(`Isolated server exited before readiness (${exit.code}, ${exit.signal}). ${server.logs()}`); }),
  ]), 6000, 'Isolated server startup exceeded six seconds.');
}

async function notificationsStream(server: RunningServer, cookie: string): Promise<{ request: ClientRequest; response: IncomingMessage; ended: Promise<void> }> {
  return await deadline(new Promise((resolve, reject) => {
    const request = http.get(server.base + '/api/notifications/events', {
      headers: { Cookie: cookie, Accept: 'text/event-stream', Connection: 'keep-alive' },
    }, response => {
      if (response.statusCode !== 200 || !String(response.headers['content-type']).includes('text/event-stream')) {
        response.resume();
        reject(new Error('Authenticated notification stream was not accepted.'));
        return;
      }
      const ended = new Promise<void>(done => response.once('end', done));
      let content = '';
      response.on('error', reject);
      response.on('data', chunk => {
        content += chunk.toString('utf8');
        if (content.includes('event: ready\n') && content.includes('\n\n')) {
          // Keep this genuine active stream open until the server ends it.
          // A client-side timeout would mask the original shutdown deadlock.
          request.setTimeout(0);
          resolve({ request, response, ended });
        }
      });
    });
    request.once('error', reject);
    request.setTimeout(2500, () => request.destroy(new Error('Notification stream did not deliver its initial event.')));
  }), 3000, 'Notification stream did not become active.');
}

async function stopOwned(server?: RunningServer) {
  if (!server || server.child.exitCode !== null || server.child.signalCode !== null) return;
  server.child.kill('SIGTERM');
  try { await deadline(server.exited, 2000, 'Owned test server did not terminate.'); }
  catch { server.child.kill('SIGKILL'); await server.exited; }
}

test('SIGTERM drains authenticated SSE before closing SQLite and preserves sessions across restart', { timeout: 15000 }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'pixel-shutdown-test-'));
  let first: RunningServer | undefined;
  let restarted: RunningServer | undefined;
  let stream: Awaited<ReturnType<typeof notificationsStream>> | undefined;
  try {
    first = await launch(dataDir);
    await ready(first);
    const account = await jsonRequest(first, '/api/auth/register', 'POST', {
      name: 'Shutdown regression account', email: 'shutdown-regression@example.test', password: 'Shutdown-test-password-2026!',
    });
    assert.equal(account.status, 201);
    assert.ok(account.cookie.startsWith('pixel_session='), 'Registration creates an opaque server session cookie.');
    const userId = account.body.user.id;
    stream = await notificationsStream(first, account.cookie);
    assert.equal(stream.response.complete, false, 'The SSE connection must still be active when shutdown starts.');

    const started = performance.now();
    first.child.kill('SIGTERM');
    const exit = await deadline(first.exited, 4500, 'SIGTERM hung while an authenticated SSE client remained connected.');
    assert.equal(exit.code, 0, first.logs());
    assert.equal(exit.signal, null);
    assert.ok(performance.now() - started < 4500, 'Shutdown drains streams rather than waiting for the 20-second force-close deadline.');
    await deadline(stream.ended, 500, 'Server did not cleanly end its SSE response.');
    assert.doesNotMatch(first.logs(), /database (?:is )?(?:not open|closed)|unhandled(?:rejection| exception)|uncaught/i);

    const database = new DatabaseSync(join(dataDir, 'pixel-world.sqlite'), { readOnly: true });
    try {
      assert.equal(database.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok');
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM users WHERE id=?').get(userId)!.count, 1);
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM sessions WHERE user_id=?').get(userId)!.count, 1);
    } finally { database.close(); }

    restarted = await launch(dataDir);
    await ready(restarted);
    const identity = await jsonRequest(restarted, '/api/auth/me', 'GET', undefined, account.cookie);
    assert.equal(identity.status, 200);
    assert.equal(identity.body.user?.id, userId, 'The same authenticated session works after a complete process restart.');
    restarted.child.kill('SIGTERM');
    assert.equal((await deadline(restarted.exited, 3000, 'Restarted child did not shut down.')).code, 0);
    assert.doesNotMatch(restarted.logs(), /database (?:is )?(?:not open|closed)|unhandled(?:rejection| exception)|uncaught/i);
    const restored = new DatabaseSync(join(dataDir, 'pixel-world.sqlite'), { readOnly: true });
    try {
      assert.equal(restored.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok');
      assert.deepEqual(restored.prepare('PRAGMA foreign_key_check').all(), []);
      assert.equal(restored.prepare('SELECT COUNT(*) AS count FROM sessions WHERE user_id=?').get(userId)!.count, 1);
    } finally { restored.close(); }
  } finally {
    stream?.response.destroy();
    stream?.request.destroy();
    await stopOwned(first);
    await stopOwned(restarted);
    await rm(dataDir, { recursive: true, force: true });
  }
});
