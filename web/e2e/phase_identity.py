"""Phase 1 browser gate. Run only against a marked, disposable local database."""
import binascii
import json
import os
from pathlib import Path
import re
import sqlite3
import struct
import sys
import traceback
from uuid import uuid4
import zlib
from playwright.sync_api import sync_playwright, expect

base = (sys.argv[1] if len(sys.argv) > 1 else os.environ.get('E2E_BASE_URL', 'http://127.0.0.1:5173')).rstrip('/')
data_dir = Path(sys.argv[2] if len(sys.argv) > 2 else os.environ.get('E2E_DATA_DIR', '/workspace/onboarding-pixel/phase-qa-data')).resolve()
approved = data_dir == Path('/workspace/onboarding-pixel/phase-qa-data') or (
    data_dir.name == 'phase-qa-data' and (data_dir / '.pixel-e2e-allow-fixtures').is_file())
if not approved or not re.fullmatch(r'http://127\.0\.0\.1:\d+', base) or base.endswith(':3001'):
    raise SystemExit('Use a local isolated QA service and an explicitly marked phase-qa-data directory; never the main runtime.')
artifacts = Path(os.environ.get('E2E_ARTIFACTS_DIR', os.environ.get('E2E_ARTIFACT_DIR', '/workspace/onboarding-pixel')))
artifacts.mkdir(parents=True, exist_ok=True)
email = f'identity-{uuid4().hex[:12]}@example.test'
password = 'Identity-QA-password-2026!'
new_password = 'Identity-QA-recovered-2026!'
errors, checks, external = [], [], []

def redact_exception(kind, error, trace):
    formatted = ''.join(traceback.format_exception(kind, error, trace))
    print(re.sub(r'(token=)[^\s&\'"]+', r'\1[REDACTED]', formatted), file=sys.stderr)
sys.excepthook = redact_exception

def ok(message):
    checks.append(message)
    print('OK', message, flush=True)

def instrument(page):
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.on('request', lambda req: external.append(req.url) if not req.url.startswith(base + '/') and not req.url.startswith('data:') else None)

def mail_link(purpose):
    for file in sorted((data_dir / 'mail-outbox').glob('*.json'), key=lambda item: item.stat().st_mtime, reverse=True):
        message = json.loads(file.read_text())
        if message['to'] == email and message['purpose'] == purpose:
            return re.search(r'https?://\S+', message['text']).group(0)
    raise AssertionError('Expected private test mail was not delivered')

def png_bytes():
    def chunk(kind, value):
        return struct.pack('!I', len(value)) + kind + value + struct.pack('!I', binascii.crc32(kind + value) & 0xffffffff)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('!IIBBBBB', 4, 4, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress((b'\x00' + b'\x44\x77\x55' * 4) * 4)) + chunk(b'IEND', b'')

def login(page, address, secret):
    page.goto(base, wait_until='networkidle')
    page.get_by_role('button', name='Đăng nhập', exact=True).first.click()
    form = page.get_by_role('dialog')
    form.get_by_label('Email', exact=True).fill(address)
    form.get_by_label('Mật khẩu', exact=True).fill(secret)
    form.get_by_role('button', name='Đăng nhập', exact=True).click()
    expect(form).to_have_count(0)

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=os.environ.get('CHROMIUM_EXECUTABLE', '/usr/bin/chromium'), headless=True, args=['--no-sandbox'])
    context = browser.new_context(viewport={'width': 1440, 'height': 1050}, reduced_motion='reduce')
    page = context.new_page()
    instrument(page)
    page.goto(base, wait_until='networkidle')
    page.get_by_role('button', name='Đăng nhập', exact=True).click()
    dialog = page.get_by_role('dialog')
    dialog.get_by_role('button', name='Đăng ký', exact=True).click()
    dialog.get_by_label('Tên hiển thị', exact=True).fill('QA Danh tính')
    dialog.get_by_label('Email', exact=True).fill(email)
    dialog.get_by_label('Mật khẩu', exact=True).fill(password)
    dialog.get_by_role('button', name='Tạo tài khoản', exact=True).click()
    expect(dialog).to_have_count(0)
    member = context.request.get(base + '/api/auth/me').json()['user']
    assert member['roles'] == ['member']
    assert context.request.get(base + '/api/admin/users').status == 403
    page.locator('.sidebar').get_by_role('button', name='Cài đặt', exact=True).click()
    expect(page.get_by_role('heading', name='Quản lý vai trò hệ thống', exact=True)).to_have_count(0)
    ok('new accounts remain ordinary members and cannot enumerate or administer accounts')

    expect(page.get_by_text('Email chưa xác minh', exact=True)).to_be_visible()
    page.get_by_role('button', name='Gửi lại email xác minh', exact=True).click()
    expect(page.get_by_text(re.compile('Yêu cầu xác minh đã'))).to_be_visible()
    verification_link = mail_link('verify_email')
    verifier_context = browser.new_context(viewport={'width': 1440, 'height': 1050}, reduced_motion='reduce')
    verifier = verifier_context.new_page()
    instrument(verifier)
    verifier.goto(verification_link, wait_until='networkidle')
    action = verifier.get_by_role('dialog', name='Xác minh email', exact=True)
    action.get_by_label('Email nhận liên kết', exact=True).fill(email)
    action.get_by_label('Mật khẩu tài khoản', exact=True).fill(password)
    action.get_by_role('button', name='Đăng nhập để xác minh', exact=True).click()
    action.get_by_role('button', name='Xác minh email', exact=True).click()
    expect(action.get_by_role('button', name='Tiếp tục', exact=True)).to_be_visible()
    assert 'token=' not in verifier.url
    action.get_by_role('button', name='Tiếp tục', exact=True).click()
    verifier.goto(verification_link, wait_until='networkidle')
    verifier.get_by_role('dialog', name='Xác minh email', exact=True).get_by_role('button', name='Xác minh email', exact=True).click()
    expect(verifier.get_by_role('alert')).to_contain_text('đã được sử dụng')
    verifier_context.close()
    page.reload(wait_until='networkidle')
    expect(page.get_by_text('Email đã xác minh', exact=True)).to_be_visible()
    ok('delivered verification requires recipient login, removes the URL token and rejects replay')

    page.get_by_label('Giới thiệu bản thân', exact=True).fill('Hồ sơ công khai có dữ liệu thật và dấu tiếng Việt.')
    page.get_by_label('Ảnh đại diện', exact=True).set_input_files({'name': 'identity-avatar.png', 'mimeType': 'image/png', 'buffer': png_bytes()})
    expect(page.get_by_text('Ảnh đã tải lên. Nhấn lưu hồ sơ để áp dụng.', exact=True)).to_be_visible()
    page.get_by_role('button', name='Lưu hồ sơ công khai', exact=True).click()
    expect(page.get_by_text('Đã lưu hồ sơ công khai.', exact=True)).to_be_visible()
    expect(page.get_by_role('img', name='Ảnh đại diện hiện tại', exact=True)).to_have_js_property('naturalWidth', 4)
    page.get_by_role('link', name='Xem hồ sơ công khai của bạn ↗', exact=True).click()
    expect(page.get_by_role('heading', name='QA Danh tính', exact=True)).to_be_visible()
    expect(page.get_by_text('Hồ sơ công khai có dữ liệu thật và dấu tiếng Việt.', exact=True)).to_be_visible()
    page.reload(wait_until='networkidle')
    expect(page.get_by_role('heading', name='QA Danh tính', exact=True)).to_be_visible()
    expect(page.get_by_role('img', name='Ảnh đại diện QA Danh tính', exact=True)).to_have_js_property('naturalWidth', 4)
    guest_context = browser.new_context(viewport={'width': 1280, 'height': 950})
    guest = guest_context.new_page()
    instrument(guest)
    guest.goto(base + '/#profile/' + member['id'], wait_until='networkidle')
    expect(guest.get_by_role('heading', name='QA Danh tính', exact=True)).to_be_visible()
    expect(guest.get_by_text(email, exact=True)).to_have_count(0)
    guest_context.close()
    ok('public bio and processed avatar survive reload without exposing the private account email')

    second_context = browser.new_context(viewport={'width': 1280, 'height': 950}, reduced_motion='reduce')
    second_page = second_context.new_page()
    instrument(second_page)
    login(second_page, email, password)
    page.get_by_role('button', name='Đăng xuất', exact=True).click()
    page.get_by_role('button', name='Đăng nhập', exact=True).click()
    page.get_by_role('button', name='Quên mật khẩu?', exact=True).click()
    page.get_by_label('Email tài khoản', exact=True).fill(email)
    page.get_by_role('button', name='Gửi liên kết khôi phục', exact=True).click()
    expect(page.get_by_text(re.compile('Nếu tài khoản|Nếu email'))).to_be_visible()
    page.goto(mail_link('reset_password'), wait_until='networkidle')
    action = page.get_by_role('dialog', name='Đặt lại mật khẩu', exact=True)
    action.get_by_label('Mật khẩu mới', exact=True).fill(new_password)
    action.get_by_role('button', name='Đặt lại mật khẩu', exact=True).click()
    expect(action.get_by_role('button', name='Tiếp tục', exact=True)).to_be_visible()
    assert 'token=' not in page.url
    action.get_by_role('button', name='Tiếp tục', exact=True).click()
    assert second_context.request.get(base + '/api/auth/me').json()['user'] is None
    second_page.reload(wait_until='networkidle')
    expect(second_page.get_by_role('button', name='Đăng nhập', exact=True)).to_be_visible()
    second_context.close()
    page.get_by_role('button', name='Đăng nhập', exact=True).first.click()
    dialog = page.get_by_role('dialog')
    dialog.get_by_label('Email', exact=True).fill(email)
    dialog.get_by_label('Mật khẩu', exact=True).fill(password)
    dialog.get_by_role('button', name='Đăng nhập', exact=True).click()
    expect(dialog.get_by_role('alert')).to_contain_text('không đúng')
    dialog.get_by_label('Mật khẩu', exact=True).fill(new_password)
    dialog.get_by_role('button', name='Đăng nhập', exact=True).click()
    expect(dialog).to_have_count(0)
    expect(page.get_by_role('button', name='Tài khoản của bạn', exact=True)).to_be_visible()
    ok('password reset invalidates the old password and every prior session before new-password login')

    page.locator('.sidebar').get_by_role('button', name='Cài đặt', exact=True).click()
    # Explicit QA fixture, restricted to this helper's own newly-created account.
    with sqlite3.connect(data_dir / 'pixel-world.sqlite') as db:
        assert db.execute('UPDATE users SET roles=?,identity_version=identity_version+1 WHERE id=?', ('["member","admin"]', member['id'])).rowcount == 1
    page.reload(wait_until='networkidle')
    roles_panel = page.locator('section.panel').filter(has=page.get_by_role('heading', name='Quản lý vai trò hệ thống', exact=True))
    expect(roles_panel).to_be_visible()
    own_details = roles_panel.locator('details').filter(has=page.locator('summary').filter(has_text=email))
    own_details.locator('summary').click()
    own_details.locator('input[name="roles"][value="developer"]').check()
    own_details.get_by_role('button', name='Lưu quyền', exact=True).click()
    expect(own_details.locator('summary')).to_contain_text('developer')
    role_user = context.request.get(base + '/api/auth/me').json()['user']
    assert 'admin' in role_user['roles'] and 'developer' in role_user['roles']
    ok('administrator UI saves a role change after an explicit isolated QA bootstrap fixture')

    assert not errors, errors
    assert not external, external
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
    page.screenshot(path=str(artifacts / 'phase-identity-desktop.png'), full_page=True)
    ok('no uncaught browser errors, external requests or desktop overflow')
    summary = {'phase': 1, 'status': 'passed', 'checkCount': len(checks), 'checks': checks, 'externalSMTP': 'not_configured_or_tested', 'fixture': 'private file mail and isolated role bootstrap'}
    (artifacts / 'phase-identity-result.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2))
    print(json.dumps({'phase': 1, 'status': 'passed', 'checks': len(checks)}, ensure_ascii=False), flush=True)
    browser.close()
