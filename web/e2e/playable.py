"""Play the bundled village game through the real isolated Docker build UI.

Only the disposable, sentinel-marked QA application started by scripts/e2e.py
is accepted. No live AI/GitHub provider or normal runtime database is used.
"""
from io import BytesIO
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from uuid import uuid4
from functools import partial
import hashlib
import json
import os
import re
import sys
import tempfile
import threading
import time
import zipfile

from playwright.sync_api import sync_playwright, expect, Error as PlaywrightError


BASE = (sys.argv[1] if len(sys.argv) > 1 else os.environ.get('E2E_BASE_URL', '')).rstrip('/')
DATA = Path(sys.argv[2] if len(sys.argv) > 2 else os.environ.get('E2E_DATA_DIR', '')).resolve()
if not re.fullmatch(r'http://127\.0\.0\.1:\d+', BASE) or BASE.endswith(':3001'):
    raise SystemExit('Use a disposable local QA service; normal runtime port 3001 is forbidden.')
if DATA.name != 'phase-qa-data' or not (DATA / '.pixel-e2e-allow-fixtures').is_file():
    raise SystemExit('A fresh sentinel-marked phase-qa-data directory is required.')
ARTIFACTS = Path(os.environ.get('E2E_ARTIFACTS_DIR', str(Path(__file__).resolve().parents[1] / '.e2e-artifacts'))).resolve()
ARTIFACTS.mkdir(parents=True, exist_ok=True)
SUFFIX = uuid4().hex[:10]
PASSWORD = 'Playable-browser-QA-2026!'
PROJECT = 'Làng chơi thật ' + SUFFIX
checks, errors, external = [], [], []
FRAME = 'iframe[title="Bản xem trước game web cô lập"]'


def ok(message):
    checks.append(message)
    print('OK', message, flush=True)


def instrument(page):
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.on('request', lambda request: external.append(request.url) if not request.url.startswith(BASE + '/') and not request.url.startswith('data:') else None)


def api(context, path):
    response = context.request.get(BASE + '/api' + path)
    assert response.ok, (path, response.status)
    return response.json()


def register(page):
    page.goto(BASE, wait_until='domcontentloaded')
    page.get_by_role('button', name='Đăng nhập', exact=True).click()
    dialog = page.get_by_role('dialog')
    dialog.get_by_role('button', name='Đăng ký', exact=True).click()
    dialog.get_by_label('Tên hiển thị', exact=True).fill('QA Người chơi ' + SUFFIX)
    dialog.get_by_label('Email', exact=True).fill('playable-' + SUFFIX + '@example.test')
    dialog.get_by_label('Mật khẩu', exact=True).fill(PASSWORD)
    dialog.get_by_role('button', name='Tạo tài khoản', exact=True).click()
    expect(dialog).to_have_count(0)
    expect(page.get_by_role('button', name='Tài khoản của bạn', exact=True)).to_be_visible()


def open_build_center(page, project_id):
    page.goto(BASE + '/#projects/' + project_id, wait_until='domcontentloaded')
    page.get_by_role('button', name='Mã nguồn & build', exact=True).click()
    expect(page.get_by_role('heading', name='Build Center', exact=True)).to_be_visible()


def wait_build(context, project_id, build_id):
    deadline = time.monotonic() + 70
    while time.monotonic() < deadline:
        build = api(context, '/projects/' + project_id + '/builds/' + build_id)['build']
        if build['status'] in ('succeeded', 'failed', 'cancelled'):
            return build
        time.sleep(.25)
    raise AssertionError('The actual Docker build did not complete within its deadline.')


def state(game, x, y, collected=0, delivered=False):
    world = game.locator('#world')
    expect(world).to_have_attribute('data-x', str(x))
    expect(world).to_have_attribute('data-y', str(y))
    expect(world).to_have_attribute('data-collected', str(collected))
    expect(world).to_have_attribute('data-delivered', str(delivered).lower())
    expect(game.get_by_label('Hạt sáng đã thu thập', exact=True)).to_have_text(str(collected) + ' / 3')


def walk(game, direction, steps):
    world = game.locator('#world')
    for _ in range(steps):
        world.press(direction)


def complete_quest(game):
    """Use only player inputs; inspect the visible world's published DOM state."""
    expect(game.get_by_role('heading', name='Làng Đèn Nhỏ', exact=False)).to_be_visible()
    state(game, 12, 12)
    world = game.locator('#world')
    world.press('e')
    state(game, 12, 12)
    walk(game, 'ArrowUp', 5)
    state(game, 12, 7)
    world.press('ArrowUp')
    state(game, 12, 7)  # The cottage at 12,6 is solid.
    world.press('e')
    state(game, 12, 7)  # Delivery before collecting all sparks is refused.
    expect(game.locator('#victory')).to_be_hidden()
    walk(game, 'ArrowDown', 5)
    walk(game, 'ArrowLeft', 6)
    state(game, 6, 12)
    world.press('e')
    state(game, 6, 12, 1)
    world.press('e')
    state(game, 6, 12, 1)  # A spark cannot be counted twice.
    walk(game, 'ArrowUp', 7)
    walk(game, 'ArrowLeft', 1)
    state(game, 5, 5, 1)
    world.press('Space')
    state(game, 5, 5, 2)
    walk(game, 'ArrowDown', 3)
    walk(game, 'ArrowRight', 14)
    state(game, 19, 8, 2)
    world.press('e')
    state(game, 19, 8, 3)
    expect(game.locator('#victory')).to_be_hidden()
    world.press('e')
    state(game, 19, 8, 3)  # Collecting three requires a separate trip home.
    walk(game, 'ArrowLeft', 7)
    walk(game, 'ArrowUp', 1)
    state(game, 12, 7, 3)
    world.press('e')
    state(game, 12, 7, 3, True)
    expect(game.get_by_role('heading', name='Đèn đã sáng, nhà đã ấm!', exact=True)).to_be_visible()
    expect(game.locator('#message')).to_contain_text('Hoàn thành!')


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(executable_path=os.environ.get('CHROMIUM_EXECUTABLE', '/usr/bin/chromium'), headless=True, args=['--no-sandbox'])
    context = browser.new_context(viewport={'width': 1440, 'height': 1100}, reduced_motion='reduce', accept_downloads=True)
    page = context.new_page()
    mobile_context = None
    instrument(page)
    try:
        register(page)
        page.goto(BASE + '/#projects', wait_until='domcontentloaded')
        page.get_by_role('button', name='Tạo dự án', exact=True).click()
        dialog = page.get_by_role('dialog', name='Gieo một ý tưởng mới', exact=True)
        dialog.get_by_label('Tên dự án', exact=True).fill(PROJECT)
        dialog.get_by_label('Mô tả dự án', exact=True).fill('Chơi game làng pixel bằng bàn phím và cảm ứng từ một bản build được kiểm thử thật.')
        with page.expect_response(lambda response: response.url == BASE + '/api/projects' and response.request.method == 'POST') as created:
            dialog.get_by_role('button', name='Tạo dự án', exact=True).click()
        assert created.value.status == 201
        project_id = created.value.json()['project']['id']
        expect(page.get_by_role('heading', name=PROJECT, exact=True)).to_be_visible()
        page.get_by_role('button', name='Mã nguồn & build', exact=True).click()
        expect(page.get_by_role('heading', name='Build Center', exact=True)).to_be_visible()
        integration = api(context, '/integrations')
        assert integration['build']['connected'] is True, 'The actual Docker runner is required.'
        assert integration['ai']['connected'] is False and integration['github']['connected'] is False
        example = page.locator('details.studio-example')
        expect(example).not_to_have_attribute('open', '')
        example.locator('summary').click()
        starter = page.get_by_role('region', name='Game làng pixel chơi được', exact=True)
        expect(starter).to_be_visible()
        expect(starter.get_by_role('button', name='Tạo bản chơi được', exact=True)).to_be_enabled()
        ok('a real account can create a private project and access the village starter without live AI or GitHub credentials')

        with page.expect_response(lambda response: response.url == BASE + '/api/projects/' + project_id + '/builds' and response.request.method == 'POST') as submitted:
            starter.get_by_role('button', name='Tạo bản chơi được', exact=True).click()
        assert submitted.value.status == 202
        initial = submitted.value.json()['build']
        build = wait_build(context, project_id, initial['id'])
        assert build['status'] == 'succeeded' and build['exitCode'] == 0, build['logs']
        assert 'executed 1 test file(s)' in build['logs']
        for expected in ('tests 3', 'pass 3', 'fail 0', 'skipped 0'):
            assert re.search(r'(?m)^(?:#|ℹ)\s+' + re.escape(expected) + r'\s*$', build['logs']), build['logs']
        expect(page.get_by_label('Log build', exact=True)).to_contain_text('executed 1 test file(s)', timeout=15000)
        artifact = build['artifact']
        with page.expect_download() as downloaded:
            page.get_by_role('link', name='Tải artifact ZIP', exact=True).click()
        content = Path(downloaded.value.path()).read_bytes()
        assert len(content) == artifact['size'] and hashlib.sha256(content).hexdigest() == artifact['sha256']
        (ARTIFACTS / 'pixel-village-playable.zip').write_bytes(content)
        with zipfile.ZipFile(BytesIO(content)) as archive:
            paths = set(archive.namelist())
            assert paths == {'index.html', 'style.css', 'game.js', 'game.test.js'}
            assert all(not path.startswith('/') and '..' not in Path(path).parts for path in paths)
        assert len(api(context, '/projects/' + project_id + '/builds')['builds']) == 1
        ok('the starter executes real JavaScript tests in Docker and produces one ZIP with matching size and SHA-256')

        expect(page.locator(FRAME)).to_be_visible(timeout=15000)
        expect(page.locator(FRAME)).to_have_attribute('sandbox', 'allow-scripts')
        frame = page.frame_locator(FRAME)
        expect(frame.locator('#world')).to_be_visible()
        assert page.locator(FRAME).evaluate('(frame)=>frame.contentDocument===null'), 'The playable iframe must keep its opaque origin.'
        ok('the successful build automatically opens the actual game in an opaque sandboxed iframe')

        complete_quest(frame)
        page.locator(FRAME).screenshot(path=str(ARTIFACTS / 'playable-desktop-victory.png'))
        ok('keyboard play blocks cottage collisions and early delivery, collects each of three sparks once and wins only after returning home')
        frame.get_by_role('button', name='Thêm một chuyến đi', exact=True).click()
        state(frame, 12, 12)
        frame.locator('#world').press('a')
        state(frame, 11, 12)
        frame.get_by_role('button', name='Chơi lại ↻', exact=True).click()
        state(frame, 12, 12)
        page.locator(FRAME).screenshot(path=str(ARTIFACTS / 'playable-desktop.png'))
        ok('both replay controls restore the initial quest and WASD remains usable')

        page.get_by_role('button', name='Đóng bản xem trước', exact=True).click()
        expect(page.locator(FRAME)).to_have_count(0)
        page.reload(wait_until='domcontentloaded')
        page.get_by_role('button', name='Mã nguồn & build', exact=True).click()
        page.get_by_role('button', name=build['version'] + ' · web', exact=False).click()
        page.get_by_role('button', name='Mở bản xem trước cô lập', exact=True).click()
        expect(page.locator(FRAME)).to_be_visible()
        state(page.frame_locator(FRAME), 12, 12)
        assert len(api(context, '/projects/' + project_id + '/builds')['builds']) == 1
        ok('closing and reloading retains the tested build; reopening starts a fresh game without creating another build')
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')

        mobile_context = browser.new_context(storage_state=context.storage_state(), viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True, reduced_motion='reduce')
        mobile = mobile_context.new_page()
        instrument(mobile)
        open_build_center(mobile, project_id)
        mobile.get_by_role('button', name=build['version'] + ' · web', exact=False).tap()
        mobile.get_by_role('button', name='Mở bản xem trước cô lập', exact=True).tap()
        expect(mobile.locator(FRAME)).to_be_visible()
        touch = mobile.frame_locator(FRAME)
        state(touch, 12, 12)
        for _ in range(6):
            touch.get_by_role('button', name='Đi sang trái', exact=True).tap()
        state(touch, 6, 12)
        touch.get_by_role('button', name='Tương tác', exact=False).tap()
        state(touch, 6, 12, 1)
        touch.get_by_role('button', name='Chơi lại ↻', exact=True).tap()
        state(touch, 12, 12)
        assert mobile.evaluate('document.documentElement.scrollWidth <= innerWidth')
        assert touch.locator('html').evaluate('(element)=>element.scrollWidth <= innerWidth')
        mobile.locator(FRAME).screenshot(path=str(ARTIFACTS / 'playable-mobile.png'))
        ok('a 390px touch screen can move, collect and reset inside the game with no parent or game horizontal overflow')

        file_policy_blocked = False
        standalone_mode = 'file_url_network_disabled'
        with tempfile.TemporaryDirectory(prefix='pixel-playable-offline-') as folder:
            with zipfile.ZipFile(BytesIO(content)) as archive:
                archive.extractall(folder)
            offline = browser.new_context(viewport={'width': 1050, 'height': 950}, reduced_motion='reduce')
            offline.set_offline(True)
            standalone = offline.new_page()
            standalone.on('pageerror', lambda error: errors.append(str(error)))
            standalone_requests = []
            standalone.on('request', lambda request: standalone_requests.append(request.url))
            try:
                standalone.goto((Path(folder) / 'index.html').as_uri(), wait_until='load')
            except PlaywrightError as error:
                if 'ERR_BLOCKED_BY_ADMINISTRATOR' not in str(error):
                    raise
                file_policy_blocked = True
                standalone_mode = 'isolated_static_http_external_requests_blocked'
            static_server = None
            try:
                if file_policy_blocked:
                    class QuietStaticHandler(SimpleHTTPRequestHandler):
                        def log_message(self, *_):
                            pass
                    static_server = ThreadingHTTPServer(('127.0.0.1', 0), partial(QuietStaticHandler, directory=folder))
                    threading.Thread(target=static_server.serve_forever, daemon=True).start()
                    static_base = 'http://127.0.0.1:' + str(static_server.server_port)
                    offline.set_offline(False)
                    def allow_static_only(route):
                        if route.request.url.startswith(static_base + '/'):
                            route.continue_()
                        else:
                            external.append(route.request.url)
                            route.abort()
                    offline.route('**/*', allow_static_only)
                    standalone.goto(static_base + '/index.html', wait_until='load')
                complete_quest(standalone)
                standalone.screenshot(path=str(ARTIFACTS / 'playable-offline-victory.png'), full_page=True)
                if not file_policy_blocked:
                    assert all(url.startswith('file:') or url.startswith('data:') for url in standalone_requests), standalone_requests
            finally:
                offline.close()
                if static_server:
                    static_server.shutdown()
                    static_server.server_close()
        if file_policy_blocked:
            ok('the extracted ZIP completes the full quest on its own static server with external requests blocked; browser policy prevents file URL verification')
        else:
            ok('the downloaded ZIP also completes the full quest from extracted index.html with browser networking disabled')
        assert not errors, errors
        assert not external, external
        ok('all playable flows finish without uncaught browser errors or external resource requests')

        result = {'gate': 'playable_village', 'result': 'passed', 'checks': len(checks), 'realDocker': True, 'liveAI': False, 'liveGitHub': False, 'standaloneMode': standalone_mode, 'fileUrlPolicyBlocked': file_policy_blocked, 'artifactSha256': artifact['sha256'], 'artifactSize': artifact['size']}
        (ARTIFACTS / 'playable-result.json').write_text(json.dumps(result, ensure_ascii=False, indent=2))
        print(json.dumps(result, ensure_ascii=False), flush=True)
    except Exception:
        page.screenshot(path=str(ARTIFACTS / 'playable-failure.png'), full_page=True)
        raise
    finally:
        if mobile_context:
            mobile_context.close()
        context.close()
        browser.close()
