"""Phase 3/4 browser gate, using real APIs and a disposable local database.

python3 web/e2e/projects.py [base-url] [isolated-data-dir]

No fixture records are written to the normal runtime database. Account emails,
passwords and one-time mail tokens are never printed. Browser writes go through
the same controls and authorization checks used by application users.
"""
import json
import os
from pathlib import Path
import re
import sys
import traceback
from uuid import uuid4

from playwright.sync_api import sync_playwright, expect


BASE = (sys.argv[1] if len(sys.argv) > 1 else os.environ.get('E2E_BASE_URL', 'http://127.0.0.1:5173')).rstrip('/')
DATA = Path(sys.argv[2] if len(sys.argv) > 2 else os.environ.get('E2E_DATA_DIR', '/workspace/onboarding-pixel/phase-qa-data')).resolve()
if not re.fullmatch(r'http://127\.0\.0\.1:\d+', BASE) or BASE.endswith(':3001'):
    raise SystemExit('Use a disposable local QA service; normal runtime port 3001 is forbidden.')
if DATA != Path('/workspace/onboarding-pixel/phase-qa-data') and not (DATA.name == 'phase-qa-data' and (DATA / '.pixel-e2e-allow-fixtures').is_file()):
    raise SystemExit('Use the approved QA data directory or a fresh sentinel-marked phase-qa-data directory.')

SUFFIX = uuid4().hex[:10]
PASSWORD = 'Project-browser-QA-2026!'
OWNER_NAME = 'QA Chủ dự án ' + SUFFIX
MEMBER_NAME = 'QA Đồng hành ' + SUFFIX
OWNER_EMAIL = 'project-owner-' + SUFFIX + '@example.test'
MEMBER_EMAIL = 'project-member-' + SUFFIX + '@example.test'
PROJECT = 'Thế giới kế hoạch ' + SUFFIX
PREDECESSOR = 'Thiết kế nền tảng ' + SUFFIX
SUCCESSOR = 'Tích hợp thế giới ' + SUFFIX
MILESTONE = 'Cột mốc đầu tiên ' + SUFFIX
CHECKLIST = 'Kiểm tra đầu vào ' + SUFFIX
COMMENT = 'Trao đổi có nhắc thành viên ' + SUFFIX
REVISION = 'Chỉnh sửa từ khách hàng ' + SUFFIX
checks, errors, external = [], [], []


def ok(message):
    checks.append(message)
    print('OK', message, flush=True)


def instrument(page):
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.on('request', lambda request: external.append(request.url) if not request.url.startswith(BASE + '/') and not request.url.startswith('data:') else None)


def api(context, path):
    response = context.request.get(BASE + '/api' + path)
    assert response.ok, (path, response.status, response.text())
    return response.json()


def verify_email(page, email):
    page.goto(BASE + '/#settings', wait_until='domcontentloaded')
    expect(page.get_by_text('Email chưa xác minh', exact=True)).to_be_visible()
    page.get_by_role('button', name='Gửi lại email xác minh', exact=True).click()
    expect(page.get_by_text(re.compile('Yêu cầu xác minh đã'))).to_be_visible()
    link = None
    for file in sorted((DATA / 'mail-outbox').glob('*.json'), key=lambda path: path.stat().st_mtime, reverse=True):
        message = json.loads(file.read_text())
        if message.get('to') == email and message.get('purpose') == 'verify_email':
            link = re.search(r'https?://\S+', message['text']).group(0)
            break
    assert link, 'The private local mail transport did not deliver the expected verification message.'
    assert link.startswith(BASE + '/#auth/'), 'Test mail origin differs from the active QA origin.'
    page.goto(link, wait_until='domcontentloaded')
    dialog = page.get_by_role('dialog', name='Xác minh email', exact=True)
    dialog.get_by_role('button', name='Xác minh email', exact=True).click()
    expect(dialog.get_by_role('button', name='Tiếp tục', exact=True)).to_be_visible()
    assert 'token=' not in page.url, 'Successful verification must remove the one-time token from the URL.'
    dialog.get_by_role('button', name='Tiếp tục', exact=True).click()
    expect(page.get_by_text('Email đã xác minh', exact=True)).to_be_visible()


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
    verify_email(page, email)


def open_project(page, project_id):
    page.goto(BASE + '/#projects/' + project_id, wait_until='domcontentloaded')
    expect(page.get_by_role('button', name='Kế hoạch & nghiệm thu', exact=True)).to_be_visible()


def planning(page):
    page.get_by_role('button', name='Kế hoạch & nghiệm thu', exact=True).click()
    expect(page.get_by_role('heading', name='Sức khỏe dự án', exact=True)).to_be_visible()


def tasks(page):
    page.get_by_role('button', name='Nhiệm vụ', exact=True).click()
    expect(page.get_by_role('heading', name='Từng bước tạo nên thế giới', exact=True)).to_be_visible()


def add_task(page, title):
    tasks(page)
    page.get_by_role('button', name='Thêm nhiệm vụ', exact=True).click()
    dialog = page.get_by_role('dialog', name='Thêm một bước tiến mới', exact=True)
    dialog.get_by_label('Tên nhiệm vụ', exact=True).fill(title)
    dialog.get_by_label('Mô tả / tiêu chí nghiệm thu', exact=True).fill('Nội dung thật cho luồng kiểm thử kế hoạch và cộng tác.')
    dialog.get_by_role('button', name=re.compile('^Thêm nhiệm vụ')).click()
    expect(dialog).to_have_count(0)
    expect(page.get_by_role('heading', name=title, exact=True)).to_be_visible()


def set_task_state(page, title, status, expected_status=200):
    with page.expect_response(lambda response: '/api/projects/' in response.url and '/tasks/' in response.url and response.request.method == 'PATCH') as event:
        page.get_by_role('combobox', name='Trạng thái ' + title, exact=True).select_option(status)
    response = event.value
    assert response.status == expected_status, (response.status, response.text())
    if expected_status == 200:
        expect(page.get_by_role('combobox', name='Trạng thái ' + title, exact=True)).to_have_value(status)


def invite(page, email, role):
    page.get_by_role('button', name='Thành viên', exact=True).click()
    page.get_by_label('Email người nhận', exact=True).fill(email)
    page.get_by_role('combobox', name=re.compile(r'^Vai trò')).select_option(role)
    page.get_by_role('button', name=re.compile('^Gửi lời mời')).click()
    expect(page.get_by_text(re.compile('Đã gửi lời mời'))).to_be_visible()


def accept_invitation(page):
    page.goto(BASE + '/#projects', wait_until='domcontentloaded')
    expect(page.get_by_role('button', name='Chấp nhận lời mời', exact=True)).to_be_visible()
    page.get_by_role('button', name='Chấp nhận lời mời', exact=True).click()
    expect(page.get_by_role('button', name='Chấp nhận lời mời', exact=True)).to_have_count(0)


def run():
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=os.environ.get('CHROMIUM_EXECUTABLE', '/usr/bin/chromium'), headless=True, args=['--no-sandbox'])
        owner_context = browser.new_context(viewport={'width': 1440, 'height': 1100}, reduced_motion='reduce')
        member_context = browser.new_context(viewport={'width': 1280, 'height': 1000}, reduced_motion='reduce')
        owner, member = owner_context.new_page(), member_context.new_page()
        for page in [owner, member]:
            page.set_default_timeout(10000)
            page.on('dialog', lambda dialog: dialog.accept())
            instrument(page)

        register(owner, OWNER_NAME, OWNER_EMAIL)
        register(member, MEMBER_NAME, MEMBER_EMAIL)
        assert api(owner_context, '/auth/me')['user']['emailVerified']
        assert api(member_context, '/auth/me')['user']['emailVerified']
        ok('two accounts register and verify their own email before project invitations')

        owner.goto(BASE + '/#projects', wait_until='domcontentloaded')
        owner.get_by_role('button', name='Tạo dự án', exact=True).click()
        dialog = owner.get_by_role('dialog', name='Gieo một ý tưởng mới', exact=True)
        dialog.get_by_label('Tên dự án', exact=True).fill(PROJECT)
        dialog.get_by_label('Mô tả dự án', exact=True).fill('Dự án riêng kiểm chứng kế hoạch, nhiệm vụ và cộng tác có phân quyền.')
        dialog.get_by_role('button', name='Tạo dự án', exact=True).click()
        expect(dialog).to_have_count(0)
        project = next(item for item in api(owner_context, '/projects')['projects'] if item['name'] == PROJECT)
        project_id = project['id']
        open_project(owner, project_id)
        assert member_context.request.get(BASE + '/api/projects/' + project_id).status == 404
        add_task(owner, PREDECESSOR)
        add_task(owner, SUCCESSOR)
        detail = api(owner_context, '/projects/' + project_id)
        predecessor = next(task for task in detail['tasks'] if task['title'] == PREDECESSOR)
        successor = next(task for task in detail['tasks'] if task['title'] == SUCCESSOR)
        ok('private project and two real tasks are created through the interface; outsiders cannot read them')

        planning(owner)
        owner.get_by_label('Tên cột mốc', exact=True).fill(MILESTONE)
        owner.get_by_label('Mô tả cột mốc', exact=True).fill('Hoàn tất phạm vi thử nghiệm có tiêu chí rõ ràng.')
        owner.get_by_label('Hạn cột mốc', exact=True).fill('2030-12-31')
        owner.get_by_role('button', name='Tạo cột mốc', exact=True).click()
        expect(owner.get_by_text(MILESTONE, exact=True)).to_be_visible()
        owner.get_by_role('combobox', name=re.compile(r'^Chọn nhiệm vụ')).select_option(successor['id'])
        owner.get_by_role('combobox', name=re.compile(r'^Nhiệm vụ cần hoàn thành trước')).select_option(predecessor['id'])
        owner.get_by_role('button', name='Thêm phụ thuộc', exact=True).click()
        expect(owner.get_by_text('Chờ: ' + PREDECESSOR, exact=True)).to_be_visible()
        owner.get_by_label('Mục checklist', exact=True).fill(CHECKLIST)
        owner.get_by_role('button', name='Thêm checklist', exact=True).click()
        expect(owner.get_by_role('checkbox', name=CHECKLIST, exact=True)).not_to_be_checked()
        owner.get_by_label('Nhãn phiên bản', exact=True).fill('QA-' + SUFFIX)
        owner.get_by_label('Ghi chú phiên bản', exact=True).fill('Ảnh chụp kế hoạch trước khi hoàn tất nhiệm vụ.')
        owner.get_by_role('button', name='Lưu phiên bản dự án', exact=True).click()
        expect(owner.get_by_text('QA-' + SUFFIX, exact=True)).to_be_visible()
        ok('milestone, task dependency, checklist and immutable version are saved through planning controls')

        tasks(owner)
        set_task_state(owner, SUCCESSOR, 'done', 409)
        expect(owner.get_by_role('alert').filter(has_text='phụ thuộc')).to_be_visible()
        assert next(task for task in api(owner_context, '/projects/' + project_id)['tasks'] if task['id'] == successor['id'])['status'] == 'todo'
        set_task_state(owner, PREDECESSOR, 'done')
        expect(owner.get_by_role('combobox', name='Trạng thái ' + PREDECESSOR, exact=True)).to_have_value('done')
        set_task_state(owner, SUCCESSOR, 'done', 409)
        expect(owner.get_by_role('alert').filter(has_text='checklist')).to_be_visible()
        planning(owner)
        owner.get_by_role('combobox', name=re.compile(r'^Chọn nhiệm vụ')).select_option(successor['id'])
        with owner.expect_response(lambda response: '/checklist/' in response.url and response.request.method == 'PATCH') as checkpoint:
            owner.get_by_role('checkbox', name=CHECKLIST, exact=True).click()
        assert checkpoint.value.status == 200, checkpoint.value.text()
        expect(owner.get_by_role('checkbox', name=CHECKLIST, exact=True)).to_be_checked()
        tasks(owner)
        set_task_state(owner, SUCCESSOR, 'review')
        expect(owner.get_by_role('combobox', name='Trạng thái ' + SUCCESSOR, exact=True)).to_have_value('review')
        planning(owner)
        owner.get_by_role('combobox', name=re.compile(r'^Chọn nhiệm vụ')).select_option(successor['id'])
        owner.get_by_label('Nhận xét nghiệm thu', exact=True).fill('Checklist và đầu vào đã hoàn tất, chấp nhận kết quả thật.')
        owner.get_by_role('button', name='Lưu quyết định nghiệm thu', exact=True).click()
        expect(owner.get_by_text('Checklist và đầu vào đã hoàn tất, chấp nhận kết quả thật.', exact=True)).to_be_visible()
        assert next(task for task in api(owner_context, '/projects/' + project_id)['tasks'] if task['id'] == successor['id'])['status'] == 'done'
        ok('incomplete dependencies and checklist block completion; approved review completes the actual task')

        plan = api(owner_context, '/projects/' + project_id + '/planning')
        saved_version = api(owner_context, '/projects/' + project_id + '/versions/' + plan['versions'][0]['id'])['version']
        assert all(task['status'] == 'todo' for task in saved_version['snapshot']['tasks'])
        owner.get_by_role('button', name='Xem ảnh chụp phiên bản', exact=True).click()
        expect(owner.locator('pre.phase-code')).to_contain_text(PREDECESSOR)
        expect(owner.locator('pre.phase-code')).to_contain_text('"status": "todo"')
        owner.get_by_role('button', name='Đóng ảnh chụp', exact=True).click()
        owner.reload(wait_until='domcontentloaded')
        planning(owner)
        expect(owner.get_by_text(MILESTONE, exact=True)).to_be_visible()
        expect(owner.get_by_text('QA-' + SUFFIX, exact=True)).to_be_visible()
        ok('version snapshots retain earlier task state and planning survives a page reload')

        invite(owner, MEMBER_EMAIL, 'developer')
        accept_invitation(member)
        open_project(member, project_id)
        planning(member)
        member.get_by_role('combobox', name=re.compile(r'^Chọn nhiệm vụ')).select_option(successor['id'])
        expect(member.get_by_role('textbox', name='Nội dung trao đổi', exact=True)).to_be_visible()
        planning(owner)
        owner.get_by_role('combobox', name=re.compile(r'^Chọn nhiệm vụ')).select_option(successor['id'])
        member.get_by_label('Nội dung trao đổi', exact=True).fill(COMMENT)
        member.get_by_role('checkbox', name=OWNER_NAME, exact=True).check()
        member.get_by_role('button', name='Gửi trao đổi nhiệm vụ', exact=True).click()
        expect(member.get_by_text(COMMENT, exact=True)).to_be_visible()
        expect(owner.get_by_text(COMMENT, exact=True)).to_be_visible(timeout=6000)
        assert any(notification['type'] == 'mention' and SUCCESSOR in notification['title'] for notification in api(owner_context, '/notifications')['notifications'])
        ok('verified invitation is accepted; task comment mentions notify a member and arrive in another browser without reload')

        owner.get_by_role('button', name='Khóa dự án', exact=True).click()
        expect(owner.get_by_role('button', name='Mở khóa', exact=True)).to_be_visible()
        expect(member.get_by_role('textbox', name='Nội dung trao đổi', exact=True)).to_have_count(0, timeout=6000)
        assert api(owner_context, '/projects/' + project_id)['project']['visibility'] == 'private'
        owner.get_by_role('button', name='Mở khóa', exact=True).click()
        expect(member.get_by_role('textbox', name='Nội dung trao đổi', exact=True)).to_be_visible(timeout=6000)
        ok('live project lock removes mutation controls and unlocking restores them without changing privacy')

        owner.get_by_role('button', name='Thành viên', exact=True).click()
        owner.get_by_role('combobox', name='Vai trò ' + MEMBER_NAME, exact=True).select_option('viewer')
        expect(member.get_by_role('textbox', name='Nội dung trao đổi', exact=True)).to_have_count(0, timeout=6000)
        owner.get_by_role('combobox', name='Vai trò ' + MEMBER_NAME, exact=True).select_option('customer')
        expect(member.get_by_role('button', name='Gửi yêu cầu chỉnh sửa', exact=True)).to_be_visible(timeout=6000)
        ok('changing a role immediately removes viewer write controls and grants only customer request controls')

        member.get_by_label('Tên yêu cầu chỉnh sửa', exact=True).fill(REVISION)
        member.get_by_label('Lý do và tiêu chí cần sửa', exact=True).fill('Bổ sung kiểm tra tương tác theo phản hồi khách hàng ' + SUFFIX)
        member.get_by_role('combobox', name=re.compile(r'^Nhiệm vụ liên quan')).select_option(successor['id'])
        member.get_by_role('button', name='Gửi yêu cầu chỉnh sửa', exact=True).click()
        expect(member.get_by_text('Bổ sung kiểm tra tương tác theo phản hồi khách hàng ' + SUFFIX, exact=False)).to_be_visible()
        detail = api(owner_context, '/projects/' + project_id)
        revision_task = next(task for task in detail['tasks'] if task['title'] == REVISION)
        assert len(detail['tasks']) == 3
        tasks(owner)
        set_task_state(owner, REVISION, 'review')
        expect(owner.get_by_role('combobox', name='Trạng thái ' + REVISION, exact=True)).to_have_value('review')
        member.get_by_role('combobox', name=re.compile(r'^Chọn nhiệm vụ')).select_option(revision_task['id'])
        expect(member.get_by_role('button', name='Lưu quyết định nghiệm thu', exact=True)).to_be_visible(timeout=6000)
        member.get_by_label('Nhận xét nghiệm thu', exact=True).fill('Khách hàng đã đối chiếu và chấp nhận chỉnh sửa ' + SUFFIX)
        member.get_by_role('button', name='Lưu quyết định nghiệm thu', exact=True).click()
        expect(member.get_by_text('Khách hàng đã đối chiếu và chấp nhận chỉnh sửa ' + SUFFIX, exact=True)).to_be_visible()
        assert next(task for task in api(owner_context, '/projects/' + project_id)['tasks'] if task['id'] == revision_task['id'])['status'] == 'done'
        ok('customer revision creates a linked task and the customer can accept only their own reviewed request')

        owner.get_by_role('button', name='Thành viên', exact=True).click()
        owner.get_by_role('button', name='Thu hồi quyền ' + MEMBER_NAME, exact=True).click()
        expect(member.get_by_role('alert').filter(has_text='Quyền truy cập dự án đã thay đổi')).to_be_visible(timeout=6000)
        assert member_context.request.get(BASE + '/api/projects/' + project_id).status == 404
        ok('membership revocation terminates the existing live project view and backend access immediately')

        owner.get_by_role('button', name='Sao chép dự án', exact=True).click()
        clone_name = PROJECT + ' (bản sao)'
        expect(owner.get_by_role('heading', name=clone_name, exact=True)).to_be_visible()
        clone = next(item for item in api(owner_context, '/projects')['projects'] if item['name'] == clone_name)
        clone_detail = api(owner_context, '/projects/' + clone['id'])
        clone_plan = api(owner_context, '/projects/' + clone['id'] + '/planning')
        assert clone['id'] != project_id and clone['visibility'] == 'private' and not clone['locked']
        assert len(clone_detail['members']) == 1 and len(clone_detail['tasks']) == 3
        assert all(task['status'] == 'todo' and task['assigneeId'] is None for task in clone_detail['tasks'])
        assert {task['id'] for task in clone_detail['tasks']}.isdisjoint({task['id'] for task in detail['tasks']})
        assert len(clone_plan['milestones']) == len(clone_plan['dependencies']) == len(clone_plan['checklists']) == 1
        assert not clone_plan['versions'] and not clone_plan['reviews'] and not clone_plan['revisions']
        planning(owner)
        expect(owner.get_by_text(MILESTONE, exact=True)).to_be_visible()
        cloned_successor = next(task for task in clone_detail['tasks'] if task['title'] == SUCCESSOR)
        owner.get_by_role('combobox', name=re.compile(r'^Chọn nhiệm vụ')).select_option(cloned_successor['id'])
        expect(owner.get_by_text('Chờ: ' + PREDECESSOR, exact=True)).to_be_visible()
        expect(owner.get_by_role('checkbox', name=CHECKLIST, exact=True)).not_to_be_checked()
        ok('full project copy remaps planning IDs, resets progress and never copies access grants or historical outcomes')

        owner.get_by_role('button', name='Chuyển vào thùng rác', exact=True).click()
        expect(owner.get_by_role('heading', name=clone_name, exact=True)).to_have_count(0)
        trash = owner.locator('details').filter(has=owner.locator('summary').filter(has_text='Thùng rác dự án'))
        trash.locator('summary').click()
        row = trash.locator('.phase-toolbar').filter(has=owner.get_by_text(clone_name, exact=True))
        expect(row).to_be_visible()
        row.get_by_role('button', name='Khôi phục dự án', exact=True).click()
        expect(owner.get_by_role('heading', name=clone_name, exact=True)).to_be_visible()
        planning(owner)
        expect(owner.get_by_text(MILESTONE, exact=True)).to_be_visible()
        assert len(api(owner_context, '/projects/' + clone['id'] + '/planning')['dependencies']) == 1
        ok('project trash and restore preserve task, milestone and dependency data through the actual lifecycle controls')

        assert not errors, errors
        assert not external, external
        assert owner.evaluate('document.documentElement.scrollWidth <= innerWidth')
        artifact_dir = Path(os.environ.get('E2E_ARTIFACTS_DIR', os.environ.get('E2E_ARTIFACT_DIR', '/workspace/onboarding-pixel')))
        artifact_dir.mkdir(parents=True, exist_ok=True)
        owner.screenshot(path=str(artifact_dir / 'phase-projects-browser.png'), full_page=True)
        member.close()
        owner_context.close()
        member_context.close()
        browser.close()
        ok('no uncaught browser errors, external requests or desktop horizontal overflow')
        print(json.dumps({'gate': 'phases_3_4_browser', 'passed': len(checks), 'failed': 0, 'checks': checks}, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    try:
        run()
    except Exception:
        detail = traceback.format_exc().replace(PASSWORD, '[REDACTED]')
        detail = re.sub(r'(token=)[A-Za-z0-9_%+\-]+', r'\1[REDACTED]', detail)
        print(detail, file=sys.stderr)
        print(json.dumps({'gate': 'phases_3_4_browser', 'passed': len(checks), 'failed': 1}, ensure_ascii=False), flush=True)
        raise SystemExit(1)
