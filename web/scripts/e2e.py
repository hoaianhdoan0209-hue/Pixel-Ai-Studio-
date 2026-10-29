"""Start an isolated application and run browser phase gates against real data.

Requires Python Playwright and an installed Chromium. No test touches the normal
runtime database. The optional build gate requires Docker and the cached Node image.
"""
from pathlib import Path
import json
import os
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request

web = Path(__file__).resolve().parents[1]
api_port = int(os.environ.get('E2E_API_PORT', '3102'))
web_port = int(os.environ.get('E2E_WEB_PORT', '5273'))
if api_port == web_port or 3001 in (api_port, web_port):
    raise SystemExit('Use two separate test ports; port 3001 is reserved for the normal runtime.')
for port in (api_port, web_port):
    with socket.socket() as probe:
        probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        probe.bind(('127.0.0.1', port))

work = Path(tempfile.mkdtemp(prefix='pixel-phase-e2e-'))
data = work / 'phase-qa-data'
data.mkdir(mode=0o700)
(data / '.pixel-e2e-allow-fixtures').touch(mode=0o600)
artifacts = Path(os.environ.get('E2E_ARTIFACTS_DIR', str(web / '.e2e-artifacts'))).resolve()
artifacts.mkdir(parents=True, exist_ok=True)
base = f'http://127.0.0.1:{web_port}'
env = dict(os.environ, NODE_ENV='development', PORT=str(api_port), HOST='127.0.0.1',
           DATA_DIR=str(data), API_TARGET=f'http://127.0.0.1:{api_port}',
           MAIL_MODE='file', REQUIRE_VERIFIED_EMAIL='true', PUBLIC_ORIGIN=base,
           BOOTSTRAP_ADMIN='false', E2E_BASE_URL=base, E2E_DATA_DIR=str(data),
           E2E_ARTIFACTS_DIR=str(artifacts), COOKIE_SECURE='false', BUILD_RUNNER_ENABLED='true')
for key in ('AI_API_KEY', 'ANTHROPIC_API_KEY', 'GH_APP_ID', 'GH_APP_PRIVATE_KEY',
            'GH_WEBHOOK_SECRET', 'APP_ENCRYPTION_KEY', 'SMTP_USER', 'SMTP_PASS'):
    env.pop(key, None)
processes = []
logs = []

def ready(url):
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        if any(p.poll() is not None for p in processes):
            raise RuntimeError('Test service exited; inspect API and frontend logs.')
        try:
            with urllib.request.urlopen(url, timeout=1) as response:
                if response.status == 200:
                    return
        except Exception:
            time.sleep(.2)
    raise RuntimeError('Test service did not become ready.')

try:
    for name, command in [
        ('api', ['node', 'node_modules/tsx/dist/cli.mjs', 'server/index.ts']),
        ('frontend', ['node', 'node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', str(web_port)]),
    ]:
        log = open(artifacts / f'{name}.log', 'w')
        logs.append(log)
        processes.append(subprocess.Popen(command, cwd=web, env=env, stdout=log,
                                          stderr=subprocess.STDOUT, start_new_session=True))
    ready(f'http://127.0.0.1:{api_port}/api/health')
    ready(base)
    selected = sys.argv[1:] or ['phase_identity', 'community', 'projects', 'builds', 'studio', 'playable']
    allowed = {'phase_identity', 'community', 'projects', 'builds', 'studio', 'playable'}
    for gate in selected:
        if gate not in allowed:
            raise ValueError('Unknown browser gate: ' + gate)
        script = web / 'e2e' / f'{gate}.py'
        if not script.is_file():
            raise RuntimeError('Required browser gate has not been implemented: ' + gate)
        print('Running browser gate: ' + gate, flush=True)
        subprocess.run([sys.executable, str(script), base, str(data)], cwd=web, env=env,
                       check=True, timeout=180)
    print(json.dumps({'result': 'passed', 'gates': selected, 'artifacts': str(artifacts)}))
finally:
    for process in processes:
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGTERM)
    for process in processes:
        try:
            process.wait(timeout=25)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
    for log in logs:
        log.close()
