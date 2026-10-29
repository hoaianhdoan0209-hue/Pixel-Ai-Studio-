"""Real village -> Studio intake -> project -> source/build browser gate.

Only scripts/e2e.py's fresh sentinel-marked local QA application is accepted.
Accounts, requests, memberships and tasks use the actual API and SQLite data.
"""
from pathlib import Path
from uuid import uuid4
import json
import os
import re
import sys
import time
from playwright.sync_api import sync_playwright, expect

BASE = sys.argv[1].rstrip('/')
DATA = Path(sys.argv[2]).resolve()
if not re.fullmatch(r'http://127\.0\.0\.1:\d+', BASE) or BASE.endswith(':3001'):
    raise SystemExit('Use the disposable local QA application, never normal port3001.')
if DATA.name != 'phase-qa-data' or not (DATA / '.pixel-e2e-allow-fixtures').is_file():
    raise SystemExit('A fresh sentinel-marked QA database is required.')
ARTIFACTS = Path(os.environ.get('E2E_ARTIFACTS_DIR', str(Path(__file__).resolve().parents[1] / '.e2e-artifacts')))
ARTIFACTS.mkdir(parents=True, exist_ok=True)
SUFFIX = uuid4().hex[:9]
PASSWORD = 'Studio-village-QA-2026!'
NAME = 'Khu vườn thiết kế ' + SUFFIX
OWNER = 'studio-owner-' + SUFFIX + '@example.test'
VIEWER = 'studio-viewer-' + SUFFIX + '@example.test'
checks, errors, external, job_posts = [], [], [], []

def ok(message):
    checks.append(message)
    print('OK', message, flush=True)

def api(context, path, method='get', data=None, expected=200):
    response = getattr(context.request, method)(BASE + '/api' + path, **({'data': data} if data is not None else {}))
    assert response.status == expected, (path, response.status, response.text())
    return response.json()

def register(page, email):
    page.goto(BASE, wait_until='domcontentloaded')
    page.get_by_role('button', name='Đăng nhập', exact=True).click()
    dialog = page.get_by_role('dialog')
    dialog.get_by_role('button', name='Đăng ký', exact=True).click()
    dialog.get_by_label('Tên hiển thị', exact=True).fill('Nhà thiết kế ' + SUFFIX)
    dialog.get_by_label('Email', exact=True).fill(email)
    dialog.get_by_label('Mật khẩu', exact=True).fill(PASSWORD)
    dialog.get_by_role('button', name='Tạo tài khoản', exact=True).click()
    expect(dialog).to_have_count(0)
    expect(page.get_by_role('button', name='Tài khoản của bạn', exact=True)).to_be_visible()

def verify(context, email):
    api(context, '/auth/verification/request', 'post', {})
    deadline = time.monotonic() + 8
    while time.monotonic() < deadline:
        for path in (DATA / 'mail-outbox').glob('*.json'):
            message = json.loads(path.read_text())
            if message['to'] == email and message['purpose'] == 'verify_email':
                token = re.search(r'https?://\S+', message['text']).group(0).split('token=', 1)[1]
                api(context, '/auth/verification/confirm', 'post', {'token': token})
                return
        time.sleep(.1)
    raise AssertionError('Private verification fixture was not delivered.')

def instrument(page):
    page.on('pageerror', lambda error: errors.append(str(error)))
    def observe(request):
        if not request.url.startswith(BASE + '/') and not request.url.startswith('data:'):
            external.append(request.url)
        if request.method == 'POST' and re.search(r'/api/ai/projects/[^/]+/jobs$', request.url):
            job_posts.append(request.url)
    page.on('request', observe)

def enter_studio(page):
    page.locator('nav[aria-label="Điều hướng chính"]').get_by_role('button', name='AI Studio', exact=False).click()
    expect(page.get_by_role('heading', name='Studio thiết kế game.', exact=True)).to_be_visible()

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(executable_path=os.environ.get('CHROMIUM_EXECUTABLE', '/usr/bin/chromium'), headless=True, args=['--no-sandbox'])
    owner = browser.new_context(viewport={'width': 1600, 'height': 1150}, reduced_motion='reduce')
    page = owner.new_page()
    instrument(page)
    mobile_context = viewer_context = None
    try:
        page.goto(BASE, wait_until='domcontentloaded')
        page.get_by_role('button', name='Vào Studio thiết kế game', exact=True).click()
        village = page.get_by_role('region', name='Làng Studio thiết kế game', exact=True)
        expect(village.get_by_role('button', name=re.compile('^Bàn '))).to_have_count(8)
        expect(village.get_by_label('Dự án đang thiết kế', exact=True)).to_be_disabled()
        connections = page.get_by_role('region', name='Hướng dẫn kết nối dịch vụ')
        expect(connections.get_by_role('heading', name='Trợ lý AI', exact=True)).to_be_visible()
        expect(connections.get_by_role('heading', name='Máy dựng game', exact=True)).to_be_visible()
        connections.get_by_text('Chưa biết nhập khóa AI ở đâu? Xem hướng dẫn Codespaces', exact=True).click()
        expect(connections.get_by_text('AI_API_KEY', exact=True)).to_be_visible()
        expect(connections.locator('input')).to_have_count(0)
        village.get_by_role('button', name='Tạo yêu cầu game', exact=True).click()
        expect(page.get_by_role('dialog')).to_be_visible()
        page.get_by_role('button', name='Đóng hộp thoại', exact=True).click()
        ok('the village opens the game-design Studio with eight workstations; guest requests require sign-in')

        register(page, OWNER)
        enter_studio(page)
        village.get_by_role('button', name='Tạo yêu cầu game', exact=True).click()
        dialog = page.get_by_role('dialog', name='Bạn muốn tạo nên điều gì?', exact=True)
        dialog.get_by_label('Tên ý tưởng', exact=True).fill(NAME)
        dialog.get_by_label('Loại sản phẩm', exact=True).select_option('game')
        dialog.get_by_label('Nền tảng', exact=True).fill('Web')
        dialog.get_by_label('Mô tả yêu cầu', exact=True).fill('Thiết kế một game xây vườn theo phong cách pixel, có nâng cấp và nhiệm vụ.')
        dialog.get_by_label('Tính năng mong muốn', exact=True).fill('Trồng cây, chế tạo vật phẩm và hoàn thành đơn hàng của dân làng.')
        dialog.get_by_label('Điều kiện nghiệm thu', exact=True).fill('Lưu tiến độ, thao tác cảm ứng và kiểm thử cơ chế kinh tế.')
        with page.expect_response(lambda response: response.url == BASE + '/api/studio/requests' and response.request.method == 'POST') as saved:
            dialog.get_by_role('button', name='Lưu yêu cầu & tạo dự án', exact=True).click()
        assert saved.value.status == 201
        result = saved.value.json()
        project_id = result['project']['id']
        expect(dialog).to_have_count(0)
        expect(village.get_by_label('Dự án đang thiết kế', exact=True)).to_have_value(project_id)
        expect(page.get_by_label('Dự án AI', exact=True)).to_have_value(project_id)
        expect(village.get_by_role('complementary', name='Tiến độ dự án trong xưởng')).to_contain_text('0/1 nhiệm vụ hoàn thành')
        request = api(owner, '/studio/requests')['requests'][0]
        assert request['id'] == result['request']['id'] and request['projectId'] == project_id
        assert request['features'].startswith('Trồng cây') and request['acceptanceCriteria'].startswith('Lưu tiến độ')
        ok('a real game brief creates a private project and intake task, persists the full questionnaire and selects the same project in the workshop and AI form')

        for role, name in [('planner', 'Lập kế hoạch'), ('game_designer', 'Thiết kế game'), ('ui_designer', 'Thiết kế giao diện'), ('developer', 'Lập trình'), ('tester', 'Kiểm thử'), ('reviewer', 'Đánh giá'), ('build_engineer', 'Dựng bản game'), ('coordinator', 'Điều phối')]:
            desk = village.get_by_role('button', name='Bàn ' + name + ' ·', exact=False)
            desk.click()
            expect(desk).to_have_attribute('aria-pressed', 'true')
            expect(page.get_by_label('Vai trò AI', exact=True)).to_have_value(role)
        page.get_by_label('Vai trò AI', exact=True).select_option('game_designer')
        expect(village.get_by_role('button', name=re.compile('^Bàn Thiết kế game ·'))).to_have_attribute('aria-pressed', 'true')
        village.get_by_role('button', name='Soạn yêu cầu', exact=False).click()
        expect(page.get_by_label('Yêu cầu cho tác vụ', exact=True)).to_be_focused()
        page.get_by_role('button', name='Điền mẫu tiếng Việt', exact=True).click()
        expect(page.get_by_label('Yêu cầu cho tác vụ', exact=True)).to_have_value(re.compile('Hãy trả lời bằng tiếng Việt'))
        expect(page.get_by_role('button', name='Điền mẫu tiếng Việt', exact=True)).to_be_disabled()
        village.get_by_role('button', name='Bàn Kiểm thử ·', exact=False).click()
        expect(page.get_by_label('Yêu cầu cho tác vụ', exact=True)).to_have_value(re.compile('Thiết kế gameplay'))
        assert not job_posts and not api(owner, '/ai/projects/' + project_id + '/jobs')['jobs']
        expect(village.locator('.studio-service-state')).to_contain_text('Chưa kết nối nhà cung cấp AI')
        ok('each desk selects the actual AI role in both directions, focuses the request form and never starts or fabricates a provider job')

        second = api(owner, '/projects', 'post', {'name': 'Bản thiết kế khác ' + SUFFIX}, expected=201)['project']
        enter_studio(page)
        # Changing pages refreshes the actual accessible project list.
        page.locator('nav[aria-label="Điều hướng chính"]').get_by_role('button', name='Dự án của bạn', exact=False).click()
        enter_studio(page)
        expect(village.get_by_label('Dự án đang thiết kế', exact=True).locator('option', has_text=second['name'])).to_have_count(1)
        page.get_by_label('Yêu cầu cho tác vụ', exact=True).fill('Yêu cầu riêng của dự án thứ nhất')
        village.get_by_label('Dự án đang thiết kế', exact=True).select_option(second['id'])
        expect(page.get_by_label('Dự án AI', exact=True)).to_have_value(second['id'])
        expect(page.get_by_label('Yêu cầu cho tác vụ', exact=True)).to_have_value('')
        expect(village.get_by_role('complementary', name='Tiến độ dự án trong xưởng')).to_contain_text('0/0 nhiệm vụ hoàn thành')
        page.get_by_label('Dự án AI', exact=True).select_option(project_id)
        expect(village.get_by_label('Dự án đang thiết kế', exact=True)).to_have_value(project_id)
        expect(village.get_by_role('complementary', name='Tiến độ dự án trong xưởng')).to_contain_text('0/1 nhiệm vụ hoàn thành')
        ok('project selectors stay synchronized and switching projects resets the request draft and real progress without mixing data')

        for label, tab, view in [('Yêu cầu & kế hoạch', 'planning', None), ('Nhiệm vụ & cộng tác', 'tasks', None), ('Mã nguồn · GitHub', 'code', 'github'), ('Kiểm thử & bản build', 'code', 'build')]:
            village.get_by_role('button', name=re.compile(re.escape(label))).click()
            expect(page.get_by_role('heading', name=NAME, exact=True)).to_be_visible()
            assert '?tab=' + tab in page.url
            if view:
                expect(page.get_by_role('tab', name='Source Code · GitHub' if view == 'github' else 'Build Center', exact=True)).to_have_attribute('aria-selected', 'true')
            page.reload(wait_until='domcontentloaded')
            expect(page.locator('.detail-tabs button.active')).to_have_text({'planning': 'Kế hoạch & nghiệm thu', 'tasks': 'Nhiệm vụ', 'code': 'Mã nguồn & build'}[tab])
            if view:
                expect(page.get_by_role('tab', name='Source Code · GitHub' if view == 'github' else 'Build Center', exact=True)).to_have_attribute('aria-selected', 'true')
            if view == 'build':
                expect(page.get_by_role('button', name='Tạo bản chơi được', exact=True)).not_to_be_visible()
            enter_studio(page)
            village.get_by_label('Dự án đang thiết kế', exact=True).select_option(project_id)
        ok('the same project opens planning, collaboration, GitHub and Build Center; each destination survives reload and the sample game stays optional')

        village.get_by_role('button', name=re.compile('^Bàn Thiết kế game ·')).click()
        page.get_by_role('region', name='Làng Studio thiết kế game').screenshot(path=str(ARTIFACTS / 'studio-village-desktop.png'))
        verify(owner, OWNER)
        viewer_context = browser.new_context(viewport={'width': 1280, 'height': 1000}, reduced_motion='reduce')
        viewer = viewer_context.new_page()
        instrument(viewer)
        register(viewer, VIEWER)
        verify(viewer_context, VIEWER)
        api(owner, '/projects/' + project_id + '/invitations', 'post', {'email': VIEWER, 'role': 'viewer'}, expected=201)
        invitation = api(viewer_context, '/invitations')['invitations'][0]
        api(viewer_context, '/invitations/' + invitation['id'] + '/accept', 'post', {})
        ai_reads = []
        viewer.on('request', lambda request: ai_reads.append(request.url) if '/api/ai/projects/' in request.url else None)
        enter_studio(viewer)
        other_village = viewer.get_by_role('region', name='Làng Studio thiết kế game')
        other_village.get_by_label('Dự án đang thiết kế', exact=True).select_option(project_id)
        expect(other_village.get_by_role('complementary', name='Tiến độ dự án trong xưởng')).to_contain_text('0/1 nhiệm vụ hoàn thành')
        expect(other_village.get_by_role('button', name=re.compile('Mã nguồn · GitHub'))).to_be_disabled()
        expect(other_village.get_by_role('button', name=re.compile('Kiểm thử & bản build'))).to_be_disabled()
        expect(viewer.get_by_role('button', name='Đưa tác vụ vào hàng đợi', exact=True)).to_have_count(0)
        assert not ai_reads, ai_reads
        api(viewer_context, '/ai/projects/' + project_id + '/jobs', expected=403)
        ok('a real invited viewer sees project progress but cannot read AI work, open private source/builds or submit jobs')

        mobile_context = browser.new_context(storage_state=owner.storage_state(), viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True, reduced_motion='reduce')
        mobile = mobile_context.new_page()
        instrument(mobile)
        mobile.goto(BASE, wait_until='domcontentloaded')
        assert mobile.evaluate('document.documentElement.scrollWidth <= innerWidth')
        mobile.get_by_role('button', name='Vào Studio thiết kế game', exact=True).tap()
        mobile_village = mobile.get_by_role('region', name='Làng Studio thiết kế game')
        mobile_village.get_by_label('Dự án đang thiết kế', exact=True).select_option(project_id)
        mobile_village.get_by_role('button', name=re.compile('^Bàn Thiết kế game ·')).tap()
        expect(mobile.get_by_label('Vai trò AI', exact=True)).to_have_value('game_designer')
        expect(mobile_village.get_by_role('button', name=re.compile('^Bàn Thiết kế game ·'))).to_have_attribute('aria-pressed', 'true')
        assert mobile.evaluate('document.documentElement.scrollWidth <= innerWidth')
        mobile_village.screenshot(path=str(ARTIFACTS / 'studio-village-mobile.png'))
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        assert not errors, errors
        assert not external, external
        assert not job_posts, job_posts
        ok('desktop and390px touch layouts keep the complete workshop usable with no horizontal overflow, browser errors or external requests')
        result = {'gate': 'studio_village', 'result': 'passed', 'checks': len(checks), 'liveAI': False, 'realData': True}
        (ARTIFACTS / 'studio-village-result.json').write_text(json.dumps(result, ensure_ascii=False, indent=2))
        print(json.dumps(result), flush=True)
    except Exception:
        page.screenshot(path=str(ARTIFACTS / 'studio-village-failure.png'), full_page=True)
        raise
    finally:
        if mobile_context: mobile_context.close()
        if viewer_context: viewer_context.close()
        owner.close()
        browser.close()
