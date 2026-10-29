"""Explicit fixture OpenAI SSE -> actual tools -> owner approval -> real Docker.

This starts browser-ai-harness.ts with a private temporary database. The normal
application has no fixture-provider fallback and no HTTP fixture configuration.
"""
from io import BytesIO
from pathlib import Path
from uuid import uuid4
import hashlib
import json
import os
import re
import signal
import socket
import subprocess
import tempfile
import time
import urllib.request
import zipfile
from playwright.sync_api import sync_playwright, expect

WEB = Path(__file__).resolve().parents[1]
API_PORT = int(os.environ.get('TOOL_E2E_API_PORT', '3202'))
WEB_PORT = int(os.environ.get('TOOL_E2E_WEB_PORT', '5373'))
if API_PORT == WEB_PORT or 3001 in (API_PORT, WEB_PORT):
    raise SystemExit('Use separate disposable test ports, never normal runtime port 3001.')
for port in (API_PORT, WEB_PORT):
    with socket.socket() as probe:
        probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        probe.bind(('127.0.0.1', port))
WORK = Path(tempfile.mkdtemp(prefix='pixel-tools-browser-'))
DATA = WORK / 'phase-qa-data'
DATA.mkdir(mode=0o700)
(DATA / '.pixel-e2e-allow-fixtures').touch(mode=0o600)
ARTIFACTS = Path(os.environ.get('E2E_ARTIFACTS_DIR', str(WEB / '.e2e-artifacts'))).resolve()
ARTIFACTS.mkdir(parents=True, exist_ok=True)
BASE = f'http://127.0.0.1:{WEB_PORT}'
ENV = dict(os.environ, NODE_ENV='test', PIXEL_TEST_HARNESS='1', PORT=str(API_PORT), DATA_DIR=str(DATA),
           PUBLIC_ORIGIN=BASE, MAIL_MODE='file', REQUIRE_VERIFIED_EMAIL='true', COOKIE_SECURE='false',
           API_TARGET=f'http://127.0.0.1:{API_PORT}', BUILD_RUNNER_ENABLED='true')
for key in ['AI_API_KEY', 'ANTHROPIC_API_KEY', 'GH_APP_ID', 'GH_APP_PRIVATE_KEY', 'GH_WEBHOOK_SECRET',
            'APP_ENCRYPTION_KEY', 'SMTP_USER', 'SMTP_PASS', 'SMTP_HOST']:
    ENV.pop(key, None)
SUFFIX = uuid4().hex[:10]
PASSWORD = 'Tools-browser-fixture-2026!'
OWNER_EMAIL = f'tools-owner-{SUFFIX}@example.test'
VIEWER_EMAIL = f'tools-viewer-{SUFFIX}@example.test'
PROJECT = 'Vườn công cụ ' + SUFFIX
checks, errors, external = [], [], []
processes, logs = [], []

def ok(message):
    checks.append(message)
    print('OK', message, flush=True)

def ready(url):
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        if any(p.poll() is not None for p in processes):
            raise AssertionError('Fixture service exited; inspect the fixture logs.')
        try:
            with urllib.request.urlopen(url, timeout=1) as response:
                if response.status == 200:
                    return
        except Exception:
            time.sleep(.2)
    raise AssertionError('Fixture service did not become ready.')

def api(context, path, method='get', data=None):
    response = getattr(context.request, method)(BASE + '/api' + path, **({'data': data} if data is not None else {}))
    return response, response.json()

def register(page, name, email):
    page.goto(BASE, wait_until='domcontentloaded')
    page.get_by_role('button', name='Đăng nhập', exact=True).click()
    dialog = page.get_by_role('dialog')
    dialog.get_by_role('button', name='Đăng ký', exact=True).click()
    dialog.get_by_label('Tên hiển thị', exact=True).fill(name)
    dialog.get_by_label('Email', exact=True).fill(email)
    dialog.get_by_label('Mật khẩu', exact=True).fill(PASSWORD)
    dialog.get_by_role('button', name='Tạo tài khoản', exact=True).click()
    expect(dialog).to_have_count(0)
    expect(page.get_by_role('button', name='Tài khoản của bạn', exact=True)).to_be_visible()

def verify(context, email):
    assert api(context, '/auth/verification/request', 'post', {})[0].ok
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        for path in (DATA / 'mail-outbox').glob('*.json'):
            message = json.loads(path.read_text())
            if message['to'] == email and message['purpose'] == 'verify_email':
                token = re.search(r'https?://\S+', message['text']).group(0).split('token=', 1)[1]
                assert api(context, '/auth/verification/confirm', 'post', {'token': token})[0].ok
                return
        time.sleep(.1)
    raise AssertionError('Private verification fixture was not delivered.')

def wait_job(context, project_id):
    deadline = time.monotonic() + 35
    while time.monotonic() < deadline:
        response, body = api(context, f'/ai/projects/{project_id}/jobs')
        assert response.ok
        if body['jobs'] and body['jobs'][0]['status'] in ['waiting_approval', 'completed', 'failed', 'cancelled']:
            return body['jobs'][0]
        time.sleep(.2)
    raise AssertionError('Fixture model job did not finish or await approval.')

def wait_build(context, project_id):
    deadline = time.monotonic() + 70
    while time.monotonic() < deadline:
        response, body = api(context, f'/projects/{project_id}/builds')
        assert response.ok
        if body['builds'] and body['builds'][0]['status'] in ['succeeded', 'failed', 'cancelled']:
            return body['builds'][0], body['builds']
        time.sleep(.25)
    raise AssertionError('Actual Docker build did not complete.')

try:
    for name, command in [
        ('tool-api', ['node', '--import', 'tsx', 'tests/browser-ai-harness.ts']),
        ('tool-web', ['node', 'node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', str(WEB_PORT)]),
    ]:
        log = open(ARTIFACTS / f'{name}.log', 'w')
        logs.append(log)
        processes.append(subprocess.Popen(command, cwd=WEB, env=ENV, stdout=log, stderr=subprocess.STDOUT, start_new_session=True))
    ready(f'http://127.0.0.1:{API_PORT}/api/health')
    ready(BASE)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=os.environ.get('CHROMIUM_EXECUTABLE', '/usr/bin/chromium'), headless=True, args=['--no-sandbox'])
        owner_context = browser.new_context(viewport={'width': 1440, 'height': 1100}, reduced_motion='reduce')
        viewer_context = browser.new_context(viewport={'width': 1280, 'height': 1000}, reduced_motion='reduce')
        page, viewer = owner_context.new_page(), viewer_context.new_page()
        for current in [page, viewer]:
            current.on('pageerror', lambda error: errors.append(str(error)))
            current.on('request', lambda request: external.append(request.url) if not request.url.startswith(BASE + '/') and not request.url.startswith('data:') else None)
        register(page, 'Tool owner', OWNER_EMAIL)
        verify(owner_context, OWNER_EMAIL)
        assert api(owner_context, '/auth/me')[1]['user']['roles'] == ['member', 'admin']
        response, data = api(owner_context, '/projects', 'post', {'name': PROJECT, 'visibility': 'private'})
        assert response.ok
        project_id = data['project']['id']
        assert api(owner_context, '/ai/pricing', 'post', {'provider': 'openai', 'model': 'browser-fixture-model', 'inputUsdPerMillion': 1, 'outputUsdPerMillion': 2, 'effectiveAt': '2026-01-01T00:00:00Z'})[0].ok
        page.goto(BASE + '/#studio', wait_until='networkidle')
        page.get_by_label('Dự án AI').select_option(project_id)
        role = page.get_by_label('Vai trò AI')
        expect(role.locator('option')).to_have_count(8)
        role.select_option('build_engineer')
        skill_panel = page.get_by_role('region', name='Kỹ năng từ GitHub', exact=True)
        skill_panel.get_by_text('Thêm skill từ GitHub', exact=True).click()
        skill_panel.get_by_label('Tên skill', exact=True).fill('Kỹ năng giao diện game')
        skill_panel.get_by_label('Liên kết SKILL.md trên GitHub', exact=True).fill('https://github.com/example/skills/blob/main/game/SKILL.md')
        with page.expect_response(lambda response: response.url.endswith('/skills') and response.request.method == 'POST') as imported:
            skill_panel.get_by_role('button', name='Đọc và lưu skill', exact=True).click()
        assert imported.value.status == 201
        skill_id = imported.value.json()['skill']['id']
        expect(skill_panel.get_by_text('Kỹ năng giao diện game · Đang bật', exact=True)).to_be_visible()

        page.get_by_label('Giới hạn tokens', exact=True).fill('1000000')
        page.get_by_label('Ngân sách ước tính USD', exact=True).fill('10')
        page.get_by_label('Output tối đa mỗi lượt', exact=True).fill('256')
        with page.expect_response(lambda response: response.url.endswith('/budget') and response.request.method == 'PUT') as saved:
            page.get_by_role('button', name='Lưu ngân sách AI', exact=True).click()
        assert saved.value.ok
        expect(page.get_by_text('0 / 1000000 tokens đã ghi nhận', exact=True)).to_be_visible()
        assert api(owner_context, f'/ai/projects/{project_id}/budget')[1]['budget']['tokenLimit'] == 1000000
        page.get_by_label('Mô hình AI', exact=True).fill('browser-fixture-model')
        page.get_by_label('Yêu cầu cho tác vụ', exact=True).fill('Read the project and propose the bounded browser fixture build ' + SUFFIX)
        consent = page.get_by_role('checkbox', name=re.compile('Cho phép công cụ dự án có kiểm soát'))
        expect(consent).not_to_be_checked()
        consent.check()
        page.get_by_role('button', name='Đưa tác vụ vào hàng đợi', exact=True).click()
        job = wait_job(owner_context, project_id)
        assert job['status'] == 'waiting_approval', job.get('errorMessage')
        assert job['agent'] == 'build_engineer' and job['toolsEnabled'] is True
        assert len(job['skills']) == 1 and job['skills'][0]['id'] == skill_id
        expect(page.get_by_text('Skill đã dùng · 1', exact=True)).to_be_visible()
        response, detail = api(owner_context, '/ai/jobs/' + job['id'])
        assert response.ok
        assert {call['name'] for call in detail['toolCalls']} == {'read_project', 'read_tasks', 'request_build'}
        assert len(detail['toolProposals']) == 1
        proposal = detail['toolProposals'][0]
        assert proposal['status'] == 'pending'
        assert api(owner_context, f'/projects/{project_id}/builds')[1]['builds'] == []
        tool_panel = page.get_by_role('region', name='Công cụ và phê duyệt AI')
        expect(tool_panel).to_be_visible(timeout=15000)
        tool_panel.get_by_text(re.compile('Nhật ký công cụ')).click()
        expect(tool_panel.get_by_text('read_project · completed', exact=True)).to_be_visible()
        expect(tool_panel.get_by_text('request_build · completed', exact=True)).to_be_visible()
        tool_panel.get_by_text(re.compile('Các tệp bất biến cần xem xét')).click()
        expect(tool_panel.get_by_role('heading', name='game.test.js', exact=True)).to_be_visible()
        ok('eight roles and explicit tool consent run native fixture SSE into durable read traces and an immutable pending proposal; no build executes before approval')

        register(viewer, 'Tool viewer', VIEWER_EMAIL)
        verify(viewer_context, VIEWER_EMAIL)
        response, invitation = api(owner_context, f'/projects/{project_id}/invitations', 'post', {'email': VIEWER_EMAIL, 'role': 'viewer'})
        assert response.ok
        assert api(viewer_context, '/invitations/' + invitation['invitation']['id'] + '/accept', 'post', {})[0].ok
        assert api(viewer_context, '/ai/jobs/' + job['id'])[0].status == 404
        assert api(viewer_context, f'/ai/projects/{project_id}/jobs')[0].status == 403
        assert api(viewer_context, '/ai/tool-proposals/' + proposal['id'] + '/approve', 'post', {'version': proposal['version']})[0].status == 403
        ok('a real viewer account cannot read AI source traces or approve a sensitive tool action')

        page.once('dialog', lambda dialog: dialog.accept())
        tool_panel.get_by_role('button', name='Phê duyệt công cụ & thực hiện', exact=True).click()
        expect(tool_panel.get_by_text(re.compile('approved · phiên bản'))).to_be_visible(timeout=15000)
        build, builds = wait_build(owner_context, project_id)
        assert len(builds) == 1 and build['status'] == 'succeeded', build.get('logs')
        assert build['exitCode'] == 0 and 'TOOL-BROWSER-ACTUAL-DOCKER' in build['logs']
        download = owner_context.request.get(BASE + build['artifact']['downloadUrl'])
        assert download.ok
        data = download.body()
        assert len(data) == build['artifact']['size']
        assert hashlib.sha256(data).hexdigest() == build['artifact']['sha256']
        with zipfile.ZipFile(BytesIO(data)) as archive:
            assert {'index.html', 'game.js', 'game.test.js'}.issubset(archive.namelist())
            assert b'Tool garden' in archive.read('index.html')
        assert api(owner_context, '/ai/tool-proposals/' + proposal['id'] + '/approve', 'post', {'version': proposal['version']})[0].status == 409
        assert len(api(owner_context, f'/projects/{project_id}/builds')[1]['builds']) == 1
        usage = api(owner_context, '/usage')[1]
        assert usage['inputTokens'] == 49 and usage['outputTokens'] == 25
        ok('owner approval invokes the actual isolated Docker bridge once, executes JavaScript tests, preserves ZIP integrity and settles all three fixture turns once')

        page.goto(BASE + '/#projects/' + project_id, wait_until='networkidle')
        page.get_by_role('button', name='Mã nguồn & build', exact=True).click()
        page.get_by_role('button', name=re.compile('tool-browser-1')).click()
        page.get_by_role('button', name='Mở bản xem trước cô lập', exact=True).click()
        frame = page.frame_locator('iframe[title="Bản xem trước game web cô lập"]')
        expect(frame.get_by_role('heading', name='Tool garden', exact=True)).to_be_visible(timeout=10000)
        frame.get_by_role('button', name='Grow garden', exact=True).click()
        expect(frame.locator('#count')).to_have_text('1')
        page.get_by_role('button', name='Đóng bản xem trước', exact=True).click()
        expect(page.locator('iframe[title="Bản xem trước game web cô lập"]')).to_have_count(0)
        ok('the actual AI-approved build opens a sandboxed playable preview and the parent can close it')
        assert not errors, errors
        assert not external, external
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        page.screenshot(path=str(ARTIFACTS / 'tool-workflow-desktop.png'), full_page=True)
        ok('no uncaught browser errors, external requests or desktop horizontal overflow')
        browser.close()
    summary = {'gate': 'ai_tools_browser', 'status': 'passed', 'checks': len(checks), 'provider': 'explicit_test_only_native_openai_sse_fixture', 'liveProviderCalled': False, 'realDocker': True}
    (ARTIFACTS / 'tool-workflow-result.json').write_text(json.dumps(summary, indent=2))
    print(json.dumps(summary), flush=True)
finally:
    for process in processes:
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGTERM)
    for process in processes:
        try:
            process.wait(timeout=20)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
    for log in logs:
        log.close()
