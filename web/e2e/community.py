"""Phase 2 browser gate against a disposable local development database only.

python3 web/e2e/community.py http://127.0.0.1:5173 /workspace/onboarding-pixel/phase-qa-data

The moderator role is an explicit fixture on a newly created QA account. This
helper refuses the normal runtime database and never prints passwords/tokens.
"""
from io import BytesIO
from pathlib import Path
from uuid import uuid4
import binascii
import hashlib
import json
import os
import re
import sqlite3
import struct
import subprocess
import sys
from tempfile import TemporaryDirectory
import traceback
import zipfile
import zlib
from playwright.sync_api import sync_playwright, expect

base = (os.environ.get('E2E_BASE_URL') or (sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:5173')).rstrip('/')
data_dir = Path(os.environ.get('E2E_DATA_DIR') or (sys.argv[2] if len(sys.argv) > 2 else '/workspace/onboarding-pixel/phase-qa-data')).resolve()
chromium_executable = os.environ.get('CHROMIUM_EXECUTABLE', '/usr/bin/chromium')
artifacts_dir = Path(os.environ.get('E2E_ARTIFACTS_DIR', os.environ.get('E2E_ARTIFACT_DIR', '/workspace/onboarding-pixel'))).resolve()
approved_data = data_dir == Path('/workspace/onboarding-pixel/phase-qa-data') or (data_dir.name == 'phase-qa-data' and (data_dir / '.pixel-e2e-allow-fixtures').is_file())
if not approved_data:
    raise SystemExit('Use the approved disposable phase-qa-data directory or create its explicit .pixel-e2e-allow-fixtures marker.')
if not re.fullmatch(r'http://127\.0\.0\.1:\d+', base) or base == 'http://127.0.0.1:3001':
    raise SystemExit('Use a local isolated QA service.')
artifacts_dir.mkdir(parents=True, exist_ok=True)

suffix = uuid4().hex[:10]
term = 'phase2-' + suffix
title = 'Khu rừng cộng đồng ' + term
category = 'Game kiểm thử ' + suffix
password = 'Community-QA-password-2026!'
checks, errors, external = [], [], []

def record_failure(kind, value, tb):
    detail = ''.join(traceback.format_exception(kind, value, tb)).replace(password, '[REDACTED]')
    detail = re.sub(r'token=[^\s&\'"<>]+', 'token=[REDACTED]', detail)
    summary = {'phase': 2, 'status': 'failed', 'checks': len(checks), 'results': checks, 'error': detail}
    (artifacts_dir / 'phase-community-summary.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2))
    print(detail, file=sys.stderr)

sys.excepthook = record_failure

def ok(message):
    checks.append(message)
    print('OK', message, flush=True)

def register(page, name, email):
    page.goto(base, wait_until='networkidle')
    page.get_by_role('button', name='Đăng nhập', exact=True).click()
    dialog = page.get_by_role('dialog')
    dialog.get_by_role('button', name='Đăng ký', exact=True).click()
    dialog.get_by_label('Tên hiển thị', exact=True).fill(name)
    dialog.get_by_label('Email', exact=True).fill(email)
    dialog.get_by_label('Mật khẩu', exact=True).fill(password)
    dialog.get_by_role('button', name='Tạo tài khoản', exact=True).click()
    expect(dialog).to_have_count(0)
    expect(page.get_by_role('button', name='Tài khoản của bạn', exact=True)).to_be_visible()

def instrument(page):
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.on('request', lambda req: external.append(req.url) if not req.url.startswith(base + '/') and not req.url.startswith('data:') else None)

def find_post(page):
    page.goto(base + '/#home', wait_until='networkidle')
    page.get_by_role('textbox', name='Tìm kiếm game', exact=True).fill(term)
    page.get_by_role('button', name=title, exact=True).click()
    dialog = page.get_by_role('dialog', name=title, exact=True)
    expect(dialog).to_be_visible()
    return dialog

def png_bytes():
    def chunk(kind, value):
        return struct.pack('!I', len(value)) + kind + value + struct.pack('!I', binascii.crc32(kind + value) & 0xffffffff)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('!IIBBBBB', 4, 4, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress((b'\x00' + b'\x44\x77\x55' * 4) * 4)) + chunk(b'IEND', b'')

archive = BytesIO()
with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_DEFLATED) as package:
    package.writestr('index.html', '<!doctype html><title>QA game</title><h1>Actual uploaded package</h1>')
archive_bytes = archive.getvalue()

def mp4_bytes():
    # Generate original fixture frames locally, rather than trusting a header-only
    # stub or downloading third-party media. The resulting clip is playable H.264.
    with TemporaryDirectory(prefix='pixel-video-qa-') as folder:
        output = Path(folder) / 'fixture.mp4'
        subprocess.run([
            os.environ.get('FFMPEG_EXECUTABLE', '/usr/bin/ffmpeg'),
            '-nostdin', '-hide_banner', '-loglevel', 'error',
            '-f', 'lavfi', '-i', 'color=c=0x447755:s=64x64:r=24',
            '-t', '1', '-an', '-c:v', 'libx264', '-threads', '1',
            '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-y', str(output),
        ], check=True, capture_output=True, timeout=20)
        return output.read_bytes()

video_bytes = mp4_bytes()

def play_video(page, video):
    expect(video).to_be_visible()
    expect(video).to_have_js_property('videoWidth', 64)
    expect(video).to_have_js_property('videoHeight', 64)
    assert 0.8 <= video.evaluate('(element) => element.duration') <= 1.2
    # A real browser click grants user activation before asking the native media
    # element to play. Advancing currentTime proves decoding, not just rendering.
    video.click()
    video.evaluate('(element) => element.play()')
    page.wait_for_function('(element) => element.currentTime > 0.15', arg=video.element_handle(), timeout=10000)
    assert video.evaluate('(element) => element.error') is None
    video.evaluate('(element) => element.pause()')

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=chromium_executable, headless=True, args=['--no-sandbox'])
    owner_context = browser.new_context(viewport={'width': 1440, 'height': 1050}, reduced_motion='reduce', accept_downloads=True)
    reader_context = browser.new_context(viewport={'width': 1280, 'height': 950}, reduced_motion='reduce', accept_downloads=True)
    mod_context = browser.new_context(viewport={'width': 1440, 'height': 1050}, reduced_motion='reduce')
    owner, reader, mod = [context.new_page() for context in [owner_context, reader_context, mod_context]]
    for page in [owner, reader, mod]:
        instrument(page)
    register(owner, 'QA Tác giả ' + suffix, 'community-owner-' + suffix + '@example.test')
    owner.get_by_role('button', name='Đăng game', exact=True).click()
    dialog = owner.get_by_role('dialog')
    dialog.get_by_label('Tên game', exact=True).fill(title)
    dialog.get_by_label('Mô tả', exact=True).fill('Game thật trong database QA, dùng kiểm chứng media và cộng đồng.')
    dialog.get_by_label('Thể loại', exact=True).fill('Phiêu lưu')
    dialog.get_by_label('Nền tảng', exact=True).fill('Web')
    dialog.get_by_label('Danh mục', exact=True).fill(category)
    dialog.locator('select[name="developmentStatus"]').select_option('recruiting')
    dialog.get_by_role('button', name='Lưu bài đăng', exact=True).click()
    expect(dialog).to_have_count(0)
    expect(owner.get_by_role('button', name=title, exact=True)).to_be_visible()
    ok('real game creation persists category, platform and recruiting metadata')

    dialog = find_post(owner)
    details = dialog.locator('details').filter(has_text='Ảnh, video & tệp đính kèm')
    details.locator('summary').click()
    details.get_by_label('Tải tệp cho bài viết', exact=True).set_input_files({'name': 'cover-' + suffix + '.png', 'mimeType': 'image/png', 'buffer': png_bytes()})
    expect(dialog.get_by_text('Đã lưu tệp.', exact=True)).to_be_visible()
    expect(dialog.locator('.phase-media-grid img')).to_have_count(1)
    expect(dialog.locator('.phase-media-grid img')).to_have_js_property('naturalWidth', 4)
    details.get_by_label('Tải tệp cho bài viết', exact=True).set_input_files({'name': 'game-' + suffix + '.zip', 'mimeType': 'application/zip', 'buffer': archive_bytes})
    attachment = dialog.locator('.phase-media-grid a').filter(has_text='game-' + suffix + '.zip')
    expect(attachment).to_be_visible()
    with owner.expect_download() as event:
        attachment.click()
    download = event.value
    assert hashlib.sha256(Path(download.path()).read_bytes()).digest() == hashlib.sha256(archive_bytes).digest()
    ok('validated image renders and uploaded ZIP downloads with unchanged bytes')

    details.get_by_label('Tải tệp cho bài viết', exact=True).set_input_files({'name': 'gameplay-' + suffix + '.mp4', 'mimeType': 'video/mp4', 'buffer': video_bytes})
    video = dialog.locator('.phase-media-grid video')
    expect(video).to_have_count(1)
    play_video(owner, video)

    release_details = dialog.locator('details').filter(has_text='Lịch sử phiên bản')
    release_details.locator('summary').click()
    release_details.get_by_label('Phiên bản phát hành', exact=True).fill('1.0.' + suffix)
    release_details.get_by_label('Ghi chú cập nhật', exact=True).fill('Bản phát hành được lưu cùng tệp game thật.')
    release_details.locator('select[name="mediaId"]').select_option(label='game-' + suffix + '.zip')
    release_details.get_by_role('button', name='Công bố phiên bản', exact=True).click()
    expect(release_details.get_by_role('heading', name='1.0.' + suffix, exact=True)).to_be_visible()
    expect(release_details.get_by_role('link', name='Tải tệp phát hành ↓', exact=True)).to_be_visible()
    dialog.get_by_role('button', name='Đóng hộp thoại', exact=True).click()
    owner.reload(wait_until='networkidle')
    dialog = find_post(owner)
    dialog.locator('summary').filter(has_text='Lịch sử phiên bản').click()
    expect(dialog.get_by_role('heading', name='1.0.' + suffix, exact=True)).to_be_visible()
    video = dialog.locator('.phase-media-grid video')
    expect(video).to_have_count(1)
    play_video(owner, video)
    ok('self-generated MP4 uploads, decodes and plays again after a complete page reload')
    dialog.get_by_role('button', name='Đóng hộp thoại', exact=True).click()
    ok('published game version retains changelog and attachment across reload')

    register(reader, 'QA Độc giả ' + suffix, 'community-reader-' + suffix + '@example.test')
    dialog = find_post(reader)
    dialog.get_by_role('combobox', name='Đánh giá game', exact=True).select_option('5')
    expect(dialog.get_by_text('★ 5.0 · 1 đánh giá', exact=True)).to_be_visible()
    dialog.get_by_role('button', name='Theo dõi tác giả', exact=True).click()
    expect(dialog.get_by_role('button', name='Ngừng theo dõi', exact=True)).to_be_visible()
    dialog.get_by_label('Bình luận của bạn', exact=True).fill('Tôi muốn đóng góp vào thế giới này ' + suffix)
    dialog.get_by_role('button', name='Gửi bình luận', exact=True).click()
    expect(dialog.get_by_text('Tôi muốn đóng góp vào thế giới này ' + suffix, exact=True)).to_be_visible()
    dialog.get_by_role('button', name='0 yêu thích', exact=True).click()
    expect(dialog.get_by_role('button', name='1 yêu thích', exact=True)).to_be_visible()
    dialog.get_by_role('button', name='Lưu game', exact=True).click()
    expect(dialog.get_by_role('button', name='Đã lưu', exact=True)).to_be_visible()
    dialog.get_by_role('button', name='Đóng hộp thoại', exact=True).click()
    reader.reload(wait_until='networkidle')
    dialog = find_post(reader)
    expect(dialog.get_by_role('combobox', name='Đánh giá game', exact=True)).to_have_value('5')
    expect(dialog.get_by_role('button', name='Ngừng theo dõi', exact=True)).to_be_visible()
    dialog.get_by_role('button', name='Đóng hộp thoại', exact=True).click()
    ok('second account rates, follows, comments, likes and bookmarks with persistence')

    dialog = find_post(owner)
    dialog.get_by_role('button', name='Trả lời QA Độc giả ' + suffix, exact=True).click()
    expect(dialog.get_by_text('Đang trả lời bình luận', exact=False)).to_be_visible()
    dialog.get_by_label('Bình luận của bạn', exact=True).fill('Cảm ơn, chúng ta cùng xây tiếp ' + suffix)
    dialog.get_by_role('button', name='Gửi bình luận', exact=True).click()
    expect(dialog.get_by_text('Trả lời bình luận trong cuộc trò chuyện', exact=True)).to_be_visible()
    dialog.get_by_role('button', name='Đóng hộp thoại', exact=True).click()
    ok('author can reply to an existing comment and retain its parent relation')

    # Pagination fixtures use real authenticated API writes in the disposable database.
    for index in range(12):
        response = owner_context.request.post(base + '/api/community/posts', data={'title': f'Game phân trang {index} {term}', 'description': 'Dữ liệu kiểm thử phân trang', 'category': 'Pagination QA', 'platform': 'Web'})
        assert response.status == 201
    owner.goto(base + '/#home', wait_until='networkidle')
    # Fixture writes happen outside React. A same-hash navigation is not a reload.
    owner.reload(wait_until='networkidle')
    owner.get_by_role('textbox', name='Tìm kiếm game', exact=True).fill(term)
    expect(owner.locator('.phase-pagination')).to_contain_text('13 bài')
    expect(owner.locator('.game-card')).to_have_count(12)
    owner.get_by_role('button', name='Trang sau', exact=True).click()
    expect(owner.locator('.game-card')).to_have_count(1)
    expect(owner.locator('.phase-pagination')).to_contain_text('Trang 2')
    owner.get_by_role('combobox', name='Lọc danh mục', exact=True).select_option(category)
    expect(owner.locator('.phase-pagination')).to_contain_text('1 bài')
    expect(owner.get_by_role('button', name=title, exact=True)).to_be_visible()
    owner.get_by_role('combobox', name='Lọc nền tảng', exact=True).select_option('Web')
    expect(owner.locator('.game-card')).to_have_count(1)
    ok('real search, category/platform filters and second-page navigation work')

    dialog = find_post(reader)
    dialog.locator('summary').filter(has_text='Báo cáo nội dung').click()
    dialog.get_by_label('Lý do báo cáo', exact=True).fill('Nội dung cần được kiểm duyệt theo yêu cầu QA ' + suffix)
    dialog.get_by_role('button', name='Gửi báo cáo', exact=True).click()
    expect(dialog.get_by_text('Đã gửi báo cáo để kiểm duyệt.', exact=True)).to_be_visible()
    dialog.get_by_role('button', name='Đóng hộp thoại', exact=True).click()

    mod_email = 'community-mod-' + suffix + '@example.test'
    register(mod, 'QA Kiểm duyệt ' + suffix, mod_email)
    # Explicit test-only fixture: the requested local QA path is checked at process start.
    with sqlite3.connect(data_dir / 'pixel-world.sqlite') as db:
        assert db.execute('UPDATE users SET roles=? WHERE email=?', ('["member","moderator"]', mod_email)).rowcount == 1
    mod.reload(wait_until='networkidle')
    mod.locator('.sidebar').get_by_role('button', name='Cài đặt', exact=True).click()
    queue = mod.locator('section.panel').filter(has=mod.get_by_role('heading', name='Hàng đợi kiểm duyệt', exact=True))
    card = queue.locator('.phase-card').filter(has=mod.get_by_text(title, exact=True))
    expect(card).to_be_visible()
    card.get_by_label('Ghi chú', exact=True).fill('Ẩn bài trong lúc kiểm chứng ' + suffix)
    card.get_by_role('button', name='Lưu quyết định kiểm duyệt', exact=True).click()
    expect(card).to_have_count(0)
    reader.reload(wait_until='networkidle')
    reader.get_by_role('textbox', name='Tìm kiếm game', exact=True).fill(title)
    expect(reader.get_by_role('button', name=title, exact=True)).to_have_count(0)
    queue.get_by_label(re.compile('^Trạng thái báo cáo')).select_option('resolved')
    card = queue.locator('.phase-card').filter(has=mod.get_by_text(title, exact=True))
    expect(card).to_be_visible()
    card.locator('select[name="action"]').select_option('restore')
    card.get_by_label('Ghi chú', exact=True).fill('Đã khôi phục sau kiểm chứng ' + suffix)
    card.get_by_role('button', name='Lưu quyết định kiểm duyệt', exact=True).click()
    reader.reload(wait_until='networkidle')
    reader.get_by_role('textbox', name='Tìm kiếm game', exact=True).fill(title)
    expect(reader.get_by_role('button', name=title, exact=True)).to_be_visible()
    ok('report submission, moderator hide and restore change actual public visibility')

    owner.screenshot(path=str(artifacts_dir / 'phase-community-desktop.png'), full_page=True)
    assert not errors, errors
    assert not external, external
    assert owner.evaluate('document.documentElement.scrollWidth <= innerWidth')
    ok('no uncaught page errors, external requests or desktop overflow')
    summary = {'phase': 2, 'status': 'passed', 'checks': len(checks), 'results': checks, 'pageErrors': errors, 'externalRequests': external, 'moderatorRole': 'explicit fixture in isolated QA database only'}
    (artifacts_dir / 'phase-community-summary.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2))
    print(json.dumps({'phase': 2, 'status': 'passed', 'checks': len(checks)}), flush=True)
    print(f'{len(checks)} Phase 2 browser checks passed', flush=True)
    browser.close()
