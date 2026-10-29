"""Phase 7 browser gate using the real isolated Docker runner.

Run only against a disposable local instance with BUILD_RUNNER_ENABLED=true.
The script registers unique test accounts and never touches the normal database.
"""
from io import BytesIO
from pathlib import Path
from uuid import uuid4
import hashlib
import json
import os
import re
import sys
import time
import zipfile

from playwright.sync_api import sync_playwright, expect

BASE = (sys.argv[1] if len(sys.argv) > 1 else os.environ.get('E2E_BASE_URL', 'http://127.0.0.1:5173')).rstrip('/')
DATA = Path(sys.argv[2] if len(sys.argv) > 2 else os.environ.get('E2E_DATA_DIR', '/workspace/onboarding-pixel/phase-qa-data')).resolve()
if not re.fullmatch(r'http://127\.0\.0\.1:\d+', BASE) or BASE.endswith(':3001'):
    raise SystemExit('Use a disposable local QA service; normal runtime port 3001 is forbidden.')
if DATA != Path('/workspace/onboarding-pixel/phase-qa-data') and not (DATA.name == 'phase-qa-data' and (DATA / '.pixel-e2e-allow-fixtures').is_file()):
    raise SystemExit('Use the approved QA data directory or a fresh sentinel-marked phase-qa-data directory.')

ARTIFACTS = Path(os.environ.get('E2E_ARTIFACTS_DIR', '/workspace/onboarding-pixel')).resolve()
ARTIFACTS.mkdir(parents=True, exist_ok=True)
SUFFIX = uuid4().hex[:10]
PASSWORD = 'Build-browser-QA-2026!'
PROJECT = 'Xưởng build thật ' + SUFFIX
checks, errors, external = [], [], []


def ok(message):
    checks.append(message)
    print('OK', message, flush=True)


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


def instrument(page):
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.on('request', lambda request: external.append(request.url) if not request.url.startswith(BASE + '/') and not request.url.startswith('data:') else None)


def request(context, path, method='get', data=None):
    return getattr(context.request, method)(BASE + '/api' + path, **({'data': data} if data is not None else {}))


def get_json(context, path):
    response = request(context, path)
    assert response.ok, (path, response.status)
    return response.json()


def wait_build(context, project_id, build_id, statuses=('succeeded', 'failed', 'cancelled'), timeout=70):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        build = get_json(context, '/projects/' + project_id + '/builds/' + build_id)['build']
        if build['status'] in statuses:
            return build
        time.sleep(.25)
    raise AssertionError('Build did not reach the expected state within the runner deadline.')


def submit_build(page, project_id, version, html, javascript='', tests='', extras=''):
    details = page.locator('details').filter(has=page.locator('summary', has_text='Tạo build web từ mã nguồn'))
    if details.get_attribute('open') is None:
        details.locator('summary').click()
    details.get_by_label('Version build', exact=True).fill(version)
    details.get_by_label('index.html', exact=True).fill(html)
    details.get_by_label('game.js · tùy chọn', exact=True).fill(javascript)
    details.get_by_label('game.test.js · tùy chọn', exact=True).fill(tests)
    details.get_by_label('Các tệp bổ sung · JSON object tùy chọn', exact=True).fill(extras)
    with page.expect_response(lambda response: response.url == BASE + '/api/projects/' + project_id + '/builds' and response.request.method == 'POST') as response:
        details.get_by_role('button', name='Chạy build web cô lập', exact=True).click()
    result = response.value
    assert result.status == 202, (result.status, result.text())
    build = result.json()['build']
    expect(page.get_by_role('heading', name='Build ' + version, exact=True)).to_be_visible()
    return build


def terminal_ui(page, state):
    pane = page.locator('section[aria-live="polite"]')
    expect(pane.locator('.tag', has_text=state)).to_be_visible(timeout=15000)
    return pane


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(executable_path=os.environ.get('CHROMIUM_EXECUTABLE', '/usr/bin/chromium'), headless=True, args=['--no-sandbox'])
    owner_context = browser.new_context(viewport={'width': 1440, 'height': 1100}, reduced_motion='reduce', accept_downloads=True)
    stranger_context = browser.new_context(viewport={'width': 1200, 'height': 1000}, reduced_motion='reduce')
    owner, stranger = owner_context.new_page(), stranger_context.new_page()
    instrument(owner)
    instrument(stranger)
    try:
        register(owner, 'QA Chủ xưởng ' + SUFFIX, 'build-owner-' + SUFFIX + '@example.test')
        owner.goto(BASE + '/#projects', wait_until='domcontentloaded')
        owner.get_by_role('button', name='Tạo dự án', exact=True).click()
        dialog = owner.get_by_role('dialog', name='Gieo một ý tưởng mới', exact=True)
        dialog.get_by_label('Tên dự án', exact=True).fill(PROJECT)
        dialog.get_by_label('Mô tả dự án', exact=True).fill('Kiểm chứng build, kiểm thử, artifact và phát hành bằng dữ liệu thật.')
        with owner.expect_response(lambda response: response.url == BASE + '/api/projects' and response.request.method == 'POST') as created:
            dialog.get_by_role('button', name='Tạo dự án', exact=True).click()
        assert created.value.status == 201
        project_id = created.value.json()['project']['id']
        expect(owner.get_by_role('heading', name=PROJECT, exact=True)).to_be_visible()
        owner.get_by_role('button', name='Mã nguồn & build', exact=True).click()
        expect(owner.get_by_role('heading', name='Build Center', exact=True)).to_be_visible()
        status = get_json(owner_context, '/integrations')
        assert status['build']['connected'] is True, 'This gate requires the actual Docker runner, not a mock or disabled runner.'
        ok('owner creates a real private project and opens the configured Docker Build Center')

        html = '<!doctype html><html lang="vi"><meta charset="UTF-8"><title>Actual browser build</title><h1>actual build ' + SUFFIX + '</h1><script src="game.js"></script></html>'
        javascript = 'module.exports = {answer: 42};'
        tests = "const assert=require('node:assert/strict');const fs=require('node:fs');assert.equal(require('/src/game.js').answer,42);assert.ok(fs.readFileSync('/src/index.html','utf8').includes('actual build " + SUFFIX + "'));console.log('UI_BUILD_ACTUAL_TEST_PASSED');"
        success = submit_build(owner, project_id, 'success-' + SUFFIX, html, javascript, tests, '{"style.css":"body { color: #264b3d; }"}')
        completed = wait_build(owner_context, project_id, success['id'])
        assert completed['status'] == 'succeeded' and completed['exitCode'] == 0
        assert 'UI_BUILD_ACTUAL_TEST_PASSED' in completed['logs'] and 'executed 1 test file(s)' in completed['logs']
        pane = terminal_ui(owner, 'Thành công')
        expect(pane.get_by_label('Log build', exact=True)).to_contain_text('UI_BUILD_ACTUAL_TEST_PASSED')
        artifact = completed['artifact']
        with owner.expect_download() as downloaded:
            pane.get_by_role('link', name='Tải artifact ZIP', exact=True).click()
        content = Path(downloaded.value.path()).read_bytes()
        assert len(content) == artifact['size'] and hashlib.sha256(content).hexdigest() == artifact['sha256']
        with zipfile.ZipFile(BytesIO(content)) as archive:
            assert set(archive.namelist()) == {'index.html', 'game.js', 'game.test.js', 'style.css'}
            assert archive.read('index.html').decode() == html and archive.read('game.js').decode() == javascript
        ok('real container executes JavaScript tests; UI exposes logs and downloads an exact SHA-256/size verified ZIP')

        register(stranger, 'QA Người ngoài ' + SUFFIX, 'build-stranger-' + SUFFIX + '@example.test')
        for path in ('/projects/' + project_id + '/builds', '/projects/' + project_id + '/builds/' + success['id'] + '/artifact'):
            assert request(stranger_context, path).status == 404
        release_details = owner.locator('details').filter(has=owner.locator('summary', has_text='Phê duyệt bản phát hành'))
        release_details.locator('summary').click()
        expect(release_details.get_by_label(re.compile('^Công khai bản phát hành'))).to_be_disabled()
        release_details.get_by_label('Version phát hành', exact=True).fill('private-' + SUFFIX)
        release_details.get_by_label('Changelog', exact=True).fill('Bản phát hành riêng được chủ dự án phê duyệt.')
        with owner.expect_response(lambda response: response.url.endswith('/releases') and response.request.method == 'POST') as private_release:
            release_details.get_by_role('button', name='Lưu bản phát hành đã duyệt', exact=True).click()
        assert private_release.value.status == 201 and private_release.value.json()['release']['published'] is False
        assert request(stranger_context, '/projects/' + project_id + '/builds/' + success['id'] + '/artifact').status == 404
        ok('private build and owner-approved private release remain inaccessible to another real account')

        syntax = submit_build(owner, project_id, 'syntax-' + SUFFIX, html, 'const broken = ;')
        syntax_result = wait_build(owner_context, project_id, syntax['id'])
        assert syntax_result['status'] == 'failed' and syntax_result['exitCode'] != 0 and syntax_result['artifact'] is None
        pane = terminal_ui(owner, 'Thất bại')
        expect(pane.get_by_role('link', name='Tải artifact ZIP', exact=True)).to_have_count(0)
        assert request(owner_context, '/projects/' + project_id + '/builds/' + syntax['id'] + '/artifact').status == 404
        assertion = submit_build(owner, project_id, 'assert-' + SUFFIX, html, javascript, "require('node:assert/strict').equal(1,2)")
        assertion_result = wait_build(owner_context, project_id, assertion['id'])
        assert assertion_result['status'] == 'failed' and assertion_result['artifact'] is None and 'AssertionError' in assertion_result['logs']
        terminal_ui(owner, 'Thất bại')
        ok('syntax and assertion failures are shown as failed builds and never expose a successful artifact')

        pending = submit_build(owner, project_id, 'cancel-' + SUFFIX, html, javascript, 'while(true){}')
        wait_build(owner_context, project_id, pending['id'], statuses=('building', 'testing'), timeout=15)
        owner.get_by_role('button', name='Hủy build', exact=True).click()
        cancelled = wait_build(owner_context, project_id, pending['id'])
        assert cancelled['status'] == 'cancelled' and cancelled['artifact'] is None
        pane = terminal_ui(owner, 'Đã hủy')
        expect(pane.get_by_role('link', name='Tải artifact ZIP', exact=True)).to_have_count(0)
        ok('owner cancels an active real Docker build; cancellation never creates an artifact')

        owner.get_by_role('button', name='Chỉnh sửa', exact=True).click()
        edit = owner.get_by_role('dialog', name='Chỉnh sửa dự án', exact=True)
        edit.locator('select[name="visibility"]').select_option('public')
        edit.get_by_role('button', name='Lưu thay đổi', exact=True).click()
        expect(edit).to_have_count(0)
        owner.get_by_role('button', name='success-' + SUFFIX + ' · web', exact=False).click()
        pane = terminal_ui(owner, 'Thành công')
        release_details = pane.locator('details').filter(has=owner.locator('summary', has_text='Phê duyệt bản phát hành'))
        if release_details.get_attribute('open') is None:
            release_details.locator('summary').click()
        release_details.get_by_label('Version phát hành', exact=True).fill('public-' + SUFFIX)
        release_details.get_by_label('Changelog', exact=True).fill('Chủ dự án chủ động phát hành artifact công khai.')
        release_details.get_by_label(re.compile('^Công khai bản phát hành')).check()
        with owner.expect_response(lambda response: response.url.endswith('/releases') and response.request.method == 'POST') as public_release:
            release_details.get_by_role('button', name='Lưu bản phát hành đã duyệt', exact=True).click()
        assert public_release.value.status == 201 and public_release.value.json()['release']['published'] is True
        public_download = request(stranger_context, '/projects/' + project_id + '/builds/' + success['id'] + '/artifact')
        assert public_download.ok and hashlib.sha256(public_download.body()).hexdigest() == artifact['sha256']
        stranger.goto(BASE + '/#projects/' + project_id, wait_until='domcontentloaded')
        stranger.get_by_role('button', name='Mã nguồn & build', exact=True).click()
        expect(stranger.get_by_text('Vai trò hiện tại không có quyền xem mã nguồn hoặc build riêng của dự án. Dự án công khai không tự công khai mã nguồn.', exact=True)).to_be_visible()
        assert request(stranger_context, '/projects/' + project_id + '/builds').status == 403
        ok('public artifact requires explicit owner release approval; public project access still does not grant source/build history')

        owner.get_by_role('tab', name='Source Code · GitHub', exact=True).click()
        expect(owner.get_by_role('heading', name='Source Code · GitHub', exact=True)).to_be_visible()
        expect(owner.get_by_text('Dự án chưa liên kết repository. Chưa có dữ liệu commit hoặc Pull Request từ GitHub.', exact=True)).to_be_visible()
        status = get_json(owner_context, '/integrations')
        assert status['github']['connected'] is False and status['ai']['connected'] is False
        assert get_json(owner_context, '/projects/' + project_id + '/repository')['repository'] is None
        ok('unconfigured GitHub and AI report the actual state without fabricated connections, commits or outputs')

        owner.screenshot(path=str(ARTIFACTS / 'phase-builds-desktop.png'), full_page=True)
        assert not errors, errors
        assert not external, external
        assert owner.evaluate('document.documentElement.scrollWidth <= innerWidth')
        ok('no uncaught browser errors, external requests, or desktop horizontal overflow')
        result = {'phase': 'static-web-builds', 'result': 'passed', 'checks': len(checks), 'realDocker': True, 'liveGitHub': 'unconfigured', 'liveAI': 'unconfigured'}
        (ARTIFACTS / 'phase-builds-result.json').write_text(json.dumps(result, ensure_ascii=False, indent=2))
        print(json.dumps(result, ensure_ascii=False), flush=True)
    except Exception:
        owner.screenshot(path=str(ARTIFACTS / 'phase-builds-failure.png'), full_page=True)
        raise
    finally:
        owner_context.close()
        stranger_context.close()
        browser.close()
