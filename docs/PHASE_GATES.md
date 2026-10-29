# Kiểm chứng theo giai đoạn

Đánh giá ngày 2026-10-29. “Đạt” dưới đây áp dụng cho luồng và môi trường ghi rõ, không đồng nghĩa toàn bộ master prompt hoặc production đã hoàn thành. Test runner Node tính cả parent tests; không cộng số browser checks vào số test backend.

## Các gate hiện tại

| Phase | Mã/luồng đã có | Backend | Trình duyệt | Dịch vụ thật / kết luận |
|---|---|---|---|---|
| 1 — Foundation | Account/session, proof email/reset, profile/avatar/public profile, role/admin | 18 tests đạt; gồm SMTP server test TLS thực có certificate verification | 6 checks đạt: member không tự tăng quyền, đúng account xác minh/link replay, profile/avatar, reset/session revocation, admin UI | Đạt luồng phát triển cục bộ. Email bên ngoài chưa được cấu hình/kiểm chứng; file mail chỉ là test delivery. |
| 2 — Community | Bài game/thảo luận, media, filters/page, tương tác, releases, report/moderation | 14 tests đạt | 9 checks đạt với hai account, media/release/tương tác/filter/kiểm duyệt và clip H.264 thật phát được sau reload | Đạt luồng local có dữ liệu thật. Video được kiểm tra trên Chromium; không tuyên bố malware scan hoặc playback mọi codec/browser. |
| 3 — Project Management | Milestone/dependency/checklist, snapshot, revisions/reviews, health/lifecycle/copy | 16 tests chung Phase3/4 đạt, gồm migrate DB v2 có dữ liệu và purge policy | 13 checks chung Phase3/4 đạt, gồm planning/completion guard/review/snapshot/copy/trash/restore | Đạt các luồng quản lý dự án được nêu. Chưa stress-test nhiều instance hoặc disaster recovery. |
| 4 — Collaboration | Verified invitation, role/capability, comments/mentions, live SSE | Cùng suite 16 tests: lock, mention, quyền, session/membership revocation | Cùng 13 checks: hai browser, invite, live update, role/lock, revision, revoke | Đạt cộng tác trong instance local. Mail delivery ngoài và mô hình nhiều instance chưa kiểm chứng. |
| 5 — AI Studio | Tám role, native tool calling opt-in, read tools, immutable source/build proposals và owner approval bridge | Có trong full suite 174/174; gồm fragmented OpenAI/Anthropic protocol, Docker bridge, approval/privacy/accounting | Studio workflow7/7 đạt: intake/project/8desk/context/handoff/viewer/mobile; tool workflow5/5 đạt với native provider fixture và Docker thật | Không có key/model access thật. Không cấp shell/repository execution tổng quát; chưa đánh dấu toàn phase hoàn thành. |
| 6 — GitHub | App/proposal/webhook; snapshot commit/blob, source hash và mandatory test-before-PR | Có trong full suite 174/174; checksum/exclusion, failed test không viết GitHub, passing Docker→owner-approved fixture PR và purge retention | UI workspace/PR chưa có gate trình duyệt riêng; live App chưa chạy | Thiếu App/installation/private key. Snapshot không phải shell checkout hoặc self-service OAuth; toàn phase chưa hoàn thành. |
| 7 — Build Center | Static-web pipeline, opaque-origin iframe preview và game **Làng Đèn Nhỏ** có sẵn | Có trong full suite 174/174; preview7/7 gồm Chromium, game bundle tests và runner/API thật | Build UI 8, gameplay 9 và tool workflow 5 checks đạt; thực thi Docker, ZIP/hash, auto-frame, keyboard/touch390px, thắng/reset/reload | Không hỗ trợ framework dependency install/Android/desktop target hoặc preview domain riêng. Game chưa lưu tiến độ/multiplayer. |
| 8 — Usage Dashboard | Pricing/reservation/settlement; aggregate tool rounds và giữ usage trước lỗi lượt sau | Có trong full suite 174/174; aggregate/rejection/uncertain rounds và settlement một lần | Tool workflow xác nhận tổng fixture49 input/25 output qua ba lượt | Cần live credential để xác nhận usage thật; fixture và estimate không phải hóa đơn. |
| 9 — Pixel World | SVG làng gốc, 4 điểm đến/keyboard, xưởng thiết kế game tám bàn, menu, modes/theme/motion | TypeScript/Vite build mới đạt | Baseline14 checks gồm mobile390px; game mới9 checks có keyboard/touch390px và no overflow | Đạt các luồng đã ghi; chưa khẳng định tất cả panel mới trên mọi mobile/browser. |
| 10 — Quality/Deployment | Test suites, migrations, Docker, backup, docs, CI workflow | Installer/schema9 full suite 174/174, 0 fail/skip/cancel; TypeScript/Vite build đạt | Sáu gate52 checks DB mới + tool workflow5/5 =57 browser checks đạt | Main runtime schema9 sau backup/integrity và draft save mới đạt. Image Docker mới, remote Actions, public deploy, pentest/load test hoặc restore task mới chưa có. |

## Bằng chứng baseline schema7 và dữ liệu test

- Full installer baseline schema7: `/workspace/onboarding-pixel/final-install.log`, exit 0, 110/110 tests. Gồm 108 tests trước đó, một regression quyền hủy build của tester và một kiểm tra SIGTERM/SSE shutdown thực. Không cộng lại focused runs.
- Phase1: `web/e2e/phase_identity.py`, summary `phase-identity-result.json`, 6 checks.
- Phase2: `web/e2e/community.py`, summary `phase-community-summary.json`, 9 checks.
- Phase3/4: `web/e2e/projects.py`, log `phase-projects-browser.log`, 13 checks.
- Phase7: `web/e2e/builds.py`, summary `phase-builds-result.json`, 8 checks với Docker thực.
- Final browser run: `/workspace/onboarding-pixel/final-e2e.log`, exit 0, gate counts 6 + 9 + 13 + 8 = 36. Launcher tạo fresh temporary data directory có sentinel và API/Vite port 3102/5273; evidence ở `web/.e2e-artifacts`.
- Browser chỉ dùng database QA riêng hoặc temporary directory có marker; role admin/moderator ban đầu là fixture rõ ràng, không seed/đổi quyền runtime chính. Runtime chính port 3001 đã migrate 2→7 sau backup, integrity/FK checks đạt và có 0 user.
- Provider/GitHub fixtures chỉ inject trong test app, không phải fallback production. TLS SMTP test cục bộ là kết nối SMTP thực, không phải gửi qua nhà cung cấp ngoài.
- Installer/start instructions mới đã lưu thành công vào environment draft, khớp schema7/110 tests/36 browser checks. Chưa publish hoặc restore ở task mới; lưu cấu hình không tự thực thi script.

Xem [TEST_REPORT.md](TEST_REPORT.md) cho phạm vi, lỗi đã sửa, lịch sử baseline và các mục chưa chạy. Khi có code mới hoặc live credential, chạy lại gate liên quan rồi cập nhật bảng; không thay kiểm thử thất bại bằng assertion yếu hơn.

## Mở rộng 008/009 và preview

`/workspace/onboarding-pixel/playable-final-install.log` ghi installer exit0, `npm ci`, full suite **174/174**, 0 fail/skip/cancel, TypeScript/Vite production build và Android15checks/Gradle build/lint đạt. Đây là full run sau game starter và project hash/reload fix, không cộng focused runs hoặc baseline vào tổng. Native tool browser workflow **5/5** đạt theo lần cuối, log `/workspace/onboarding-pixel/playable-final-tools.log`, summary `web/.e2e-artifacts/tool-workflow-result.json`: tám role/consent, fragmented native OpenAI SSE fixture, read traces, immutable proposal, viewer confidentiality/approval403, owner bridge thực thi Docker một lần, JS tests/ZIP hash, aggregate usage49/25 và iframe chơi counter0→1 rồi đóng. Không có uncaught page errors, external requests hoặc desktop overflow trong gate.

Provider/GitHub là transport fixtures inject rõ ràng; Docker/Chromium là thực. Preview kiểm tra các bề mặt thoát/mạng đã nêu, không phải ranh giới mạng tuyệt đối. Các kết quả này không khẳng định live SMTP/AI/GitHub hoặc UI workspace/PR đã đạt. Bộ mặc định năm browser gates đã chạy trên schema9 với database mới và đạt **45 checks** (6+9+13+8+9), log `/workspace/onboarding-pixel/playable-final-e2e.log`; không cộng lại số36 baseline/rerun trước game.

Game starter có source/test thật: Docker chạy ba test gameplay, iframe tự mở, browser hoàn thành nhiệm vụ ba vật phẩm/giao ở cửa nhà/thắng/chơi lại, giữ context project/build sau reload và dùng nút chạm390px. ZIP bốn tệp đã giải nén rồi chơi trọn nhiệm vụ qua staticHTTP với external requests bị chặn; `file://` chưa xác nhận do browser QA policy. Xem [TEST_REPORT.md](TEST_REPORT.md) cho artifact/hash và phạm vi chi tiết. Main runtime đã backup trước schema7→9, health/integrity/FK đạt, users0/posts0, runner thật bật và AI/GitHub disconnected. Không seed dữ liệu QA vào runtime.

Draft mới đã được tool xác nhận `status=saved`, `requires_publish=true` với `install_script`/`start_skill` đầy đủ cho schema9,174 backend và45+5 browser checks. Network và các requirement khác được giữ nguyên. Chưa publish hoặc chứng minh restore ở task mới; người dùng review/save trong environment settings rồi publish. Evidence draft schema7 ở trên là lịch sử.

## Làng Studio thiết kế game — giao diện đã nối luồng

Bản cập nhật xưởng tám bàn và handoff theo dự án đã chạy full backend174/174 (0 fail/skip) + sáu browser gates52/52 + native-tool5/5 =57. Logs: `studio-final-tests.log`, `studio-final-build.log`, `studio-final-e2e.log`, `studio-final-tools.log` trong `/workspace/onboarding-pixel`. Studio gate7 kiểm tra intake thật, project/role hai chiều, draft không đi theo dự án khác, nguồn/build/planning đúng đích qua reload, viewer và390px. Mẫu game đã thu gọn tùy chọn trong Build Center. Main runtime phục vụ bundle mới với schema9, integrity hợp lệ,0 users/posts. Đây là validation trong cloud, chưa phải public website deployment.
