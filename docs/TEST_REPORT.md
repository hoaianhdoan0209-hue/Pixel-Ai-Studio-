# Báo cáo kiểm thử

Ngày đánh giá: 2026-10-29. [PHASE_GATES.md](PHASE_GATES.md) đối chiếu từng giai đoạn. Các số dưới đây là kết quả đã chạy; code/component tồn tại không được coi là bằng chứng kiểm thử.

## Làng Studio thiết kế game

Thay đổi theo mục tiêu Pixel AI World: xưởng pixel tám bàn làm việc, dự án/vai trò được đồng bộ với biểu mẫu AI, tiến độ nhiệm vụ thật, chuyển đúng project đến kế hoạch/cộng tác/GitHub/Build Center và giữ đích qua reload. Mẫu Làng Đèn Nhỏ được đặt trong mục thu gọn tùy chọn của Build Center.

Gate mới `web/e2e/studio.py` đạt **7/7** trên SQLite QA mới: guest cần đăng nhập; yêu cầu game lưu đủ nội dung và tạo project/task thật; tám vai trò đồng bộ hai chiều, soạn yêu cầu không tự chạy AI; đổi dự án không mang theo draft; handoff/reload đúng project/tab; viewer thật không được đọc AI hoặc mở source/build riêng; desktop và390px cảm ứng không tràn ngang/JS error/external request. Log focused: `/workspace/onboarding-pixel/studio-e2e.log`. Không gọi AI thật hoặc dùng dữ liệu runtime.

Đã sửa lỗi form yêu cầu tự mở lại khi quay về Studio (tín hiệu mở được tiêu thụ), dự án mới không cập nhật ngay vào xưởng, draft AI có thể đi theo project khác và đích Source/Build chưa được lưu trong URL. Full run sau thay đổi đã hoàn tất: backend **174/174**,0 fail/skip/cancel (`studio-final-tests.log`); TypeScript/Vite build đạt (`studio-final-build.log`). Bộ mặc định sáu browser gates đạt **52/52** = identity6+community9+projects13+builds8+studio7+playable9, log `/workspace/onboarding-pixel/studio-final-e2e.log`. Gate native tool riêng đạt5/5, log `/workspace/onboarding-pixel/studio-final-tools.log`: tổng **57 browser checks**, không cộng lại kết quả lịch sử bên dưới. GitHub/provider vẫn là fixture rõ ràng; Docker/Chromium là thực. Main runtime đã phục vụ bundle Studio mới, schema9/integrity hợp lệ và0 users/posts; QA không ghi vào runtime.

Ảnh `studio-village-desktop.png`/`studio-village-mobile.png` ở ignored `.e2e-artifacts` là giao diện thật với dữ liệu QA. Liên kết filesystem `/workspace/...` không phải tệp đính kèm tải xuống trong chat; phiên hiện tại không có công cụ upload/attachment. Không coi việc tạo ZIP nội bộ là đã giao được tệp cho người dùng.

## Lịch sử trước thay đổi giao diện Studio — schema9/tools/game

Installer cuối `/workspace/onboarding-pixel/playable-final-install.log` hoàn tất exit0: `npm ci`, full `npm test` **174/174**, 0 failed, skipped hoặc cancelled, TypeScript/Vite production build và Android15 core checks/Gradle build/lint đều đạt. Node đếm cả parent tests. Frontend build1,588 modules, JS415.53kB/gzip122.45kB. Đây là lần chạy sau khi thêm game starter và sửa project hash/reload; không dùng số172 của lần trước game để kết luận mã mới.

Suite mới `provider-tools.test.ts`, `ai-tools.test.ts`, `source-workspace.test.ts`, `preview.test.ts`, `game-starter.test.ts` đã chạy trong full suite, cùng các regression cũ. Provider protocol kiểm tra native fragmented OpenAI tool calls và Anthropic tool blocks, serialization qua nhiều lượt và từ chối stream malformed/incomplete/duplicate/unknown. Source tests có thêm regression giữ snapshot khi purge; game starter kiểm tra bundle đúng source validator và thực thi ba test gameplay nhúng. Không dùng focused count cũ để suy ra tổng full run.

Focused evidence trước full run, giữ để tra cứu phạm vi:

| Suite/lần chạy | Kết quả | Phạm vi |
|---|---|---|
| ai-tools.test.ts | 15/15 đạt | Read tools, tám role, owner approval/idempotency, role/lock/payload, aggregate budget/usage/retry, schema7→8 và default bridge chạy Docker thật/ZIP. Log ai-tools-focused.log. |
| integrations.test.ts + source-workspace.test.ts | 18/18 đạt | Integration11 được chạy lại với gate validation mới, source workspace7; Git blob checksum, private path exclusion, invalid/symlink/truncated rejection, failed tests không viết GitHub, passing Docker→owner-approved fixture PR, bridge auth/idempotency. Log source-workspace-tests.log. |
| preview.test.ts | 7/7 đạt theo focused run | Assembly, capability một lần/session/expiry/revocation/source immutability và Chromium gameplay/opaque-origin/escape tests. Không suy ra network isolation tuyệt đối của mọi browser protocol. |

Các focused runs không được cộng vào tổng174 hoặc baseline110. Native provider và GitHub transport vẫn là fixture inject rõ ràng; Docker/Chromium trong các gate được ghi là thực. Trước gameplay, full schema9 từng đạt172/172 (`schema9-tests.log`) và TypeScript/Vite build (`schema9-build.log`); đây là lịch sử, không cộng hai lần.

Full run giữ các regression: lượt provider sau bị từ chối không xóa usage lượt trước; viewer/customer không được đọc trace/code AI và SSE phải dừng sau downgrade; proposal chỉ chạy sau owner approval, đúng version/hash/quyền hiện tại; PR đòi đúng source/validation/base SHA; snapshot giữ lại chặn purge dù không có AI/build record; preview gameplay không có quyền origin ứng dụng chính. Live SMTP/AI/GitHub vẫn chưa có credential được cấp.

## Browser workflow native tools và playable preview

`python3 e2e/tool_workflow.py` chạy lại sau bản cuối và hoàn tất **5/5 checks**, exit0, trên API/Vite và database QA riêng. Log `/workspace/onboarding-pixel/playable-final-tools.log`, summary `web/.e2e-artifacts/tool-workflow-result.json`, ảnh `tool-workflow-desktop.png`. Lần gate trước có log `tool-workflow-final.log`; không cộng hai lần. Không dùng database runtime.

1. Tám role và opt-in tool rõ ràng; native OpenAI SSE fixture phân mảnh qua ba lượt tạo read traces bền vững và immutable pending proposal; chưa duyệt thì không có build.
2. Account viewer thật bị chặn đọc AI source traces và approve action nhạy cảm.
3. Owner approval gọi production bridge chạy Docker thực đúng một lần; test JavaScript chạy, ZIP khớp hash, usage tổng49 input/25 output được settlement một lần. Đây là usage fixture, không phải provider bill.
4. Build đã duyệt mở trong iframe sandbox thật; gameplay counter0→1 và parent đóng được frame.
5. Không có uncaught page error, external request hoặc desktop horizontal overflow.

Provider là fixture chỉ inject vào test harness; không có live provider call. Gate counter chứng minh pipeline chơi được; game làng pixel có gate riêng bên dưới. UI source workspace/PR chưa có browser gate riêng.

## Browser gates schema9 chạy lại

Bộ mặc định năm gate identity/community/projects/builds/playable hoàn tất **45/45 checks** (6+9+13+8+9), exit0, log `/workspace/onboarding-pixel/playable-final-e2e.log`, trên database QA mới sau sửa project hash/reload. Launcher dùng API/Vite non-watch và Docker thực cho build; không ghi fixtures vào runtime. Native tool browser workflow 5 checks ở trên là gate riêng: tổng browser hiện tại **50 checks**, không cộng lại số36 baseline hoặc lần rerun trước gameplay (`final-schema9-e2e.log`).

## Game làng pixel chơi được

Gate `playable` hoàn tất **9/9 checks**, exit0, log `/workspace/onboarding-pixel/playable-e2e.log`. **Làng Đèn Nhỏ** là game tự chứa bốn tệp có source/logic thực. Nút **Tạo bản chơi được** gửi build qua Docker; ba test gameplay bên trong bundle chạy thật trước khi artifact và iframe được mở. Không cần key AI/GitHub và không có provider fixture trong gameplay này.

Browser kiểm tra hoàn thành nhiệm vụ bằng bàn phím, va chạm, giao quá sớm bị từ chối, ba vật phẩm chỉ được nhặt một lần, giao ở cửa nhà mới thắng, hai nút chơi lại và WASD; auto-open iframe opaque-origin; reload vẫn tìm lại project/build; điều khiển chạm trên viewport390px di chuyển/nhặt/reset không overflow. Không có page errors hoặc external requests. Một lỗi thật được tìm và sửa: tạo/chọn project trước đây chỉ đổi React state nên reload làm mất project; các đường tạo/chọn/Studio/notification/back/hashchange nay giữ URL hash nhất quán, và gate giữ assertion reload.

ZIP thực có bốn tệp, **20,143 byte**, SHA-256 `10615b1ee2ed75131ae56a7eddf44ab05a3b57b1d95724c8f7abbdde97cc093d`, evidence `web/.e2e-artifacts/pixel-village-playable.zip`. ZIP đã được giải nén rồi chơi trọn nhiệm vụ qua static HTTP server riêng với request ngoài bị chặn. Mở trực tiếp `file://` chưa được xác nhận vì policy của trình duyệt QA từ chối; không coi đó là test đạt. Ảnh `playable-desktop.png` và `playable-desktop-victory.png` ghi gameplay.

Full installer 174/174 và bộ mặc định 45 browser checks sau thay đổi gameplay đã đạt. Bản chơi hiện chưa lưu tiến độ, chưa hỗ trợ multiplayer hoặc xuất Android/desktop.

## Runtime hiện tại và cấu hình lưu lại

Database runtime chính được backup nhất quán vào `/workspace/onboarding-pixel/backups/pre-schema9-20261029.sqlite` trước khi nâng schema7→9. Sau restart bằng `npm start` production, health trả schema9/status ok, client mới anonymous, database integrity ok/FK0 và users0/posts0. Runner thực được bật; bundle đang phục vụ chứa game starter mới. AI/GitHub vẫn disconnected. Không đưa QA account/game/post vào dữ liệu runtime.

Website Docker image chưa được rebuild cho phiên bản mới; evidence container schema7 ở dưới là lịch sử. Installer hiện thêm Python venv/Playwright1.62 và prerequisite browser trước backend preview tests. Environment draft đã lưu thành công bản mới (`status=saved`, `requires_publish=true`), thay toàn bộ `install_script`/`start_skill`, giữ nguyên network và requirement metadata khác. Nội dung mới gồm schema9, tám role/tools, source approval bridge, preview 15 phút/game starter, Playwright venv và174 backend/45+5 browser checks. Credential chỉ được lưu bằng yêu cầu tên, không đưa giá trị vào script. Người dùng cần review/save trong environment settings rồi publish; lưu draft không tự áp dụng/chạy script/publish. Không có public deployment, remote Actions hoặc proof restore ở task mới.

## Backend và runner baseline schema7

Installer baseline schema7 đã chạy `npm ci`, `npm test`, Gradle và production build thành công, exit 0. Full suite hoàn tất **110/110**, 0 failed, skipped hoặc cancelled. Log: /workspace/onboarding-pixel/final-install.log. Node runner tính cả parent tests; không cộng focused runs thêm vào tổng này.

| Suite | Runner tests | Phạm vi |
|---|---:|---|
| backend.test.ts + studio.test.ts | 24 đạt | Auth/session, Origin/ownership/draft, community cơ bản, invitations/role/lock/conflict, restart persistence và intake atomic rollback. |
| identity.test.ts | 18 đạt | Token hash/purpose/expiry/replay/resend, đúng account xác minh, reset/session revocation, email change mất proof, role version/last-admin/audit, avatar owner/public profile, file mode private và mail TLS. |
| community.test.ts | 14 đạt | Filters/page/discussion, rating/follow, image reencode, private attachment, ZIP bytes/path/size, quota, report/hide/restore qua route cũ/mới và restart. |
| projects.test.ts | 16 đạt | Migration DB v2 có dữ liệu, milestone/version, cycle/cross-project/dependency/checklist guards, revision/review, full clone/trash/restore/purge retention, comments/mentions, locks và SSE revocation/logout/expiry. |
| ai.test.ts | 19 đạt | OpenAI/Anthropic SSE contract fixtures, atomic reservation/idempotency, approval→task graph, provenance/settlement, retry429/timeout/cancel/concurrency/shutdown/restart/privacy và malformed/truncated stream. |
| integrations.test.ts | 11 đạt | GitHub injected transport: JWT/installation/encrypted token, owner approval/branch isolation/HMAC/idempotency; build API/private artifact/public release/cancel/restart và unconfigured status. |
| runner.test.ts | 6 đạt | Docker thực: bounded source, syntax/test execution, không có host sentinel/secret/network/socket, read-only input/root, failure không có artifact, timeout/cancel và cleanup. |
| build-permissions.test.ts | 1 đạt | Regression quyền hủy build của tester; quyền source/build được kiểm tra ở backend. |
| shutdown.test.ts | 1 đạt | Process nhận SIGTERM khi có SSE đang mở vẫn shutdown đúng, không treo chờ stream. |

SMTP fixture thực dùng Nodemailer qua TLS với certificate được tin cậy rõ ràng; kết nối thiếu trust bị từ chối và không tạo token usable. Đây là test SMTP cục bộ, không xác nhận tài khoản/sender/provider bên ngoài.

Provider và GitHub tests inject transport rõ ràng trong app test. Chưa có credential/model access/App installation thật để xác nhận API bên ngoài. Không có fake provider/GitHub fallback trong runtime.

Log “API error: intentional test failure” thuộc test cố tình làm task insertion thất bại để kiểm tra rollback; runner vẫn xác nhận đúng kết quả. Không phải lỗi production bị bỏ qua hoặc một test bị disable.

## Browser gates baseline schema7

Final `npm run e2e` hoàn tất exit 0 qua cả bốn gate trên fresh temporary data directory có sentinel, API/Vite port 3102/5273. Tổng **36 browser checks** = 6 + 9 + 13 + 8. Browser dùng Chromium/Playwright, account thật trong SQLite QA, private file mail và fixtures được đánh dấu; không dùng database runtime người dùng. Final log: /workspace/onboarding-pixel/final-e2e.log; evidence: web/.e2e-artifacts. Các focused log trước đó ở /workspace/onboarding-pixel.

| Gate | Kết quả | Bằng chứng |
|---|---|---|
| Phase1 identity | 6 checks đạt | phase_identity.py; phase-identity-result.json và phase-identity-browser.log. |
| Phase2 community | 9 checks đạt | community.py; phase-community-summary.json; gồm clip H.264 MP4 tạo bằng ffmpeg, decode/play sau reload. |
| Phase3/4 projects/team | 13 checks đạt | projects.py; phase-projects-browser.log có summary cuối. |
| Phase7 real Build UI | 8 checks đạt với Docker thực | builds.py; phase-builds-result.json: job/test/log/ZIP/hash, private/public release, failure/cancel, quyền source và trạng thái AI/GitHub thực. |
| AI/GitHub live UI | Bị chặn live gate | Chưa có credential ngoài. Empty/configuration state không thay lời gọi thật. |

Phase1 kiểm tra đăng ký không tự tăng quyền; đúng account theo link verification, URL token được xóa/replay bị từ chối; bio/avatar sau refresh không lộ email riêng; reset làm old password và các session cũ mất hiệu lực; admin UI cập nhật role bằng explicit QA bootstrap fixture.

Phase2 kiểm tra game metadata/category/platform/recruiting; ảnh reencode hiển thị; ZIP download byte-for-byte; release/changelog qua reload; second-account rating/follow/comment/like/bookmark/reply; search/filter/page; report/moderator hide/restore thay đổi public visibility thật. Clip H.264 một giây được tạo bằng ffmpeg, upload và Chromium decode/play sau reload; không suy ra hỗ trợ mọi codec/browser.

Phase3/4 kiểm tra hai account có proof email trước invite; private project và task; milestone/dependency/checklist/snapshot; task bị chặn khi chưa đủ điều kiện rồi review hoàn thành; live mention/notification sang browser khác; lock/role/revocation cập nhật control và backend; customer revision/acceptance; clone remap/reset không sao chép access/history; trash/restore giữ dữ liệu.

Cả bốn gate không ghi uncaught page error, external request hoặc desktop horizontal overflow. Account admin/moderator được cấp trong database QA có chủ đích; đây không phải đường tự tăng quyền của production user.

Build UI gate chạy container thật và tải ZIP được kiểm tra SHA-256/kích thước/byte nguồn; private artifact/release không được đọc bởi account ngoài. Syntax/assertion failure và cancellation không tạo artifact thành công. Chỉ release được owner publish rõ ràng mới cho public download; public project không tự mở source/build history.

Một số run trước đó bị ngắt bởi backend hot-reload khi agent sửa file, tạo ECONNRESET/ECONNREFUSED, hoặc selector fixture không khớp toàn bộ thông báo. Final launcher chạy các gate đến summary cuối sau correction/freeze; không dùng run bị ngắt làm kết quả đạt và không bỏ assertion.

## Build/typecheck/audit và deployment baseline schema7

Final installer /workspace/onboarding-pixel/install.sh exit 0: npm ci, 110 tests, Gradle 43 tasks thành công và TypeScript/Vite production build hoàn tất. Vite transform 1,587 modules, JS 377.49 kB (gzip 109.48 kB), không lỗi. Log final-install.log là bằng chứng phiên bản schema7 trước mở rộng 008/009/preview, không thay gate mã mới.

Audit baseline báo 0 advisory trong 298 dependencies. Đây không phải pentest và không bảo đảm advisory tương lai.

Docker image mới đã build và chạy trong production container disposable: schema7/health, session/register, Sharp PNG→WebP upload/download, SMTP unconfigured trả 503 và runner disabled khi không có daemon. Restart giữ post đã lưu; container/volume test được dọn sau kiểm chứng. Không đánh đồng website container với runner nhận mã người dùng.

Runtime chính port 3001 đã backup trước khi migrate schema2→7; integrity/foreign-key checks hợp lệ, users=0 và không có fixtures. BUILD_RUNNER_ENABLED=true ở cloud host hiện tại; public container không được cấp Docker socket. Đây là current-instance validation, không phải public production deployment hoặc proof restore ở task mới.

Đã có workflow .github/workflows/web-quality.yml và runner E2E trong web/scripts/e2e.py; mặc định cả bốn gate, có ffmpeg cho fixture video. Shell export đã được kiểm tra, nhưng chưa có xác nhận workflow chạy trên GitHub Actions. Chưa public production deployment, load benchmark, independent pentest hoặc restore ở cloud task mới.

Environment draft baseline đã được lưu thành công: install_script/start_skill chứa workflow đã kiểm chứng 110 tests, 36 E2E checks, schema7, Docker và prerequisite tích hợp; tool trả status=saved, requires_publish=true. Giá trị credential không được ghi vào script. Lưu draft không tự execute/apply/publish; người dùng cần review/save settings rồi publish. Không có xác nhận publish hoặc new-task restoration.

## Baseline onboarding trước mở rộng schema7

Các kết quả sau đã chạy với phiên bản đầu; giữ làm lịch sử, không dùng thay browser/build gate cho code mới:

- npm test 24/24, TypeScript/Vite build warning-free, 14 browser checks trên dev và Docker production; no page errors/external requests/overflow, gồm mobile390px.
- Docker image của website đã build/chạy với TLS egress verification giữ nguyên; restart container giữ published QA post. Container/volume QA đã dọn, image retained. Không phải pipeline Build Center do người dùng gửi mã.
- Installer /workspace/onboarding-pixel/install.sh đã chạy exit0: verified tool archives, SDK/Gradle, npm ci, 24 tests và build. Cần cập nhật/validate lại chỉ dẫn khi workflow hiện tại thay đổi.
- Runtime sạch schema2 ban đầu trả HTML/health/feed rỗng/user null; không seed tài khoản. Tiến trình không được giả định sống qua restore.
- Online backup/restore QA có integrity ok và counts bằng nhau: users8/posts4/comments4/projects4/tasks3/customer_requests1/notifications13. Backup DB không thay backup media/artifact hoặc disaster recovery production.
- install_script/start_skill baseline đã được lưu draft; publication và new-task restoration chưa được xác minh.

Ảnh baseline QA world-desktop.png/world-mobile.png có fixtures; pixel-world-clean-desktop.png/pixel-world-clean-mobile.png là runtime sạch tại thời điểm chụp. Ảnh browser gates mới có prefix phase-identity/community/projects.

## Android được giữ nguyên

| Kiểm tra baseline | Kết quả |
|---|---|
| node tests.mjs | 15 checks đạt. |
| node --check cho 6 JS assets | Đạt. |
| Offline browser asset smoke | 10 checks đạt; helper /workspace/onboarding-pixel/web-smoke.py. |
| Gradle assembleDebug/lintDebug | Đạt với Java17/Gradle8.11.1/SDK35/AGP8.9.2; 43 tasks lần đầu. |
| Android lint | 0 error; DataExtractionRules và MissingApplicationIcon là 2 warning. |
| APK signature | apksigner verify đạt, v2 scheme, một signer. |

APK baseline: app/build/outputs/apk/debug/app-debug.apk, 69,525 byte; SHA-256 96dfc7ae3f04edda0f7a8c3b9e361c75bf75e6e0a78891b3bdc3f4174dacf7bd. Đây là debug APK, không phải release ký riêng. Chưa cài/chạy trên Android thật/emulator, chưa xác nhận native export hoặc Minecraft gameplay.

## Scenario A–L

| Scenario | Bằng chứng và phần còn thiếu |
|---|---|
| A — Community | Browser mới đạt post→account khác tương tác→notification; media/moderation/release có dữ liệu thật. |
| B — Request→Planner→Tasks | Intake thật; planner approval/task creation đạt protocol fixtures. Chưa gọi AI thật, nên toàn scenario live chưa đạt. |
| C — Collaboration | Browser Phase3/4 đạt invite/proof/member/task/review/mention/live quyền. |
| D — GitHub branch/diff/test/PR | Full suite schema9 đạt snapshot/checksum/source hash và actual Docker test-before-owner-approved fixture PR. Actual App chưa cấu hình; UI source workspace/PR chưa có browser gate riêng. |
| E — Build pipeline/artifact | Full suite schema9, native tool browser workflow và game starter 9/9 đạt với Docker/artifact thật, iframe và standalone staticHTTP chơi trọn nhiệm vụ; framework/Android chưa hỗ trợ. |
| F — Customer Revision | API/browser đạt request→task→review/acceptance; chưa có AI tự xử lý và kiểm thử code qua provider thật. |
| G — Security | Backend private-project/role/source/build/download/Origin/session guards; fixtures không thay pentest. |
| H — Project Lock | API/browser đạt khóa/mở khóa và immediate permission controls. |
| I — AI Budget | Contract fixtures đạt reservation/settlement/usage provenance; chưa có actual provider usage/hóa đơn. |
| J — Persistence | HTTP restart + browser reload/logout/login + media/version/planning records được kiểm chứng. |
| K — Concurrent Updates | Stale-version/atomic budget concurrency tests đạt; chưa stress-test multi-instance. |
| L — Integration Failure | Unconfigured/timeout/retry/truncated/cancel/restart fixtures và runner failure đạt; chưa thử ngắt/recovery dịch vụ ngoài đang kết nối. |

Các giới hạn production và quyền được ghi tại [SECURITY.md](SECURITY.md); không tự chuyển mục chưa chạy/bị chặn thành “đạt”.

## Hướng dẫn nhập tiếng Việt trong Studio

Đã Việt hóa tên tám bàn AI, tên vai trò trong biểu mẫu/lịch sử và các thẻ kết nối chính. Chi tiết kỹ thuật được thu gọn; thêm hướng dẫn Codespaces Secrets, không có biểu mẫu nhận khóa trong trình duyệt. Mỗi vai trò có mẫu yêu cầu tiếng Việt. Mẫu chỉ điền khi ô đang trống, không tự gửi tác vụ và không ghi đè bản nháp khi đổi vai trò; đổi project xóa bản nháp như trước.

Bản cập nhật giao diện chạy TypeScript/Vite build thành công; gate Studio7/7 và native-tool5/5 đạt. Studio gate bổ sung kiểm tra mẫu tiếng Việt, giữ bản nháp và hướng dẫn khóa không chứa input nhận secret. Logs: /workspace/onboarding-pixel/vietnamese-build.log, vietnamese-studio.log, vietnamese-tools.log. Provider vẫn là fixture rõ ràng; không tuyên bố AI thật đã được cấu hình hoặc trả lời tiếng Việt qua API ngoài.

## Skill GitHub — schema10

Full backend180/180,0 fail/skip/cancel; TypeScript/Vite build đạt. Suite mới skills.test.ts6 tests: URL cố định host/chặn SSRF và URL có credentials/query; owner/lock/privacy; giới hạn stream/HTML/404/duplicate; role scope; version conflict; idempotency/snapshot sau tắt/xóa; provider fixture nhận tài liệu đúng vai trò ở user context và ngân sách gồm skill. Logs skills-all-tests.log/skills-focused.log/skills-build.log trong /workspace/onboarding-pixel.

Studio browser7/7 và native tool5/5 đạt. Native gate mới nhập skill qua biểu mẫu thật, fixture HTTPS trả SKILL.md, xác nhận snapshot ở job/UI và native provider SSE nhận marker skill ở mọi lượt trước khi owner duyệt Docker. Browser fixture không gọi AI ngoài. Log skills-studio.log/skills-tools.log.

Đã nhập SKILL.md công khai thật từ anthropics/skills/main/skills/frontend-design qua endpoint ứng dụng và lưu SQLite QA:9389 byte Markdown sau trim, SHA256 c3d0d3ea592ad4f01215009a7ebcf7b7d948f568c15dd77e24ff7172c8643f2b. Đây là bằng chứng GitHub read/import thật; không phải gọi AI thật hoặc thực thi nội dung skill. QA không ghi vào runtime chính. Schema9/runtime chứng minh ở các phần cũ là lịch sử, chưa dùng để khẳng định runtime của người dùng đã nâng lên10.
