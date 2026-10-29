import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Contract tests must never use an operator's live credentials or send email.
// Individual suites inject explicit fixture transports and private test settings.
const environment = { ...process.env, NODE_ENV: 'test', REQUIRE_VERIFIED_EMAIL: 'false', BUILD_RUNNER_ENABLED: 'false' };
for (const name of [
  'AI_API_KEY', 'ANTHROPIC_API_KEY', 'GH_APP_ID', 'GH_APP_PRIVATE_KEY',
  'GH_WEBHOOK_SECRET', 'APP_ENCRYPTION_KEY', 'PUBLIC_ORIGIN', 'MAIL_MODE',
  'SMTP_HOST', 'SMTP_PORT', 'SMTP_FROM', 'SMTP_USER', 'SMTP_PASS',
  'SMTP_SECURE', 'SMTP_CA_FILE',
]) delete environment[name];
const root = fileURLToPath(new URL('../', import.meta.url));
const files = readdirSync(new URL('../tests/', import.meta.url))
  .filter(name => name.endsWith('.test.ts')).sort().map(name => `tests/${name}`);
if (!files.length) throw new Error('No backend tests found.');
const child = spawn(process.execPath, ['--import', 'tsx', '--test', ...files], {
  cwd: root, env: environment, stdio: 'inherit',
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
