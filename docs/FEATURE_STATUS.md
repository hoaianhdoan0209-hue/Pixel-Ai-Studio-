# Tình trạng chức năng

Đối chiếu ngày 2026-10-29 với [đặc tả gốc](MASTER_PROMPT.md). [PHASE_GATES.md](PHASE_GATES.md) ghi riêng mã nguồn, kiểm thử backend, trình duyệt và dịch vụ thật. Có API hoặc giao diện chưa đủ để kết luận toàn bộ một phase đã hoàn thành.

Mục tiêu sản phẩm là **Pixel AI World: ngôi làng Studio để thiết kế và phát triển game**, đồng thời giữ nguyên ứng dụng Android. Làng mở các không gian cộng đồng, dự án và xưởng AI. Xưởng có tám bàn làm việc, chọn cùng một dự án với biểu mẫu AI và các lối đi đến kế hoạch, nhiệm vụ, mã nguồn và build. **Làng Đèn Nhỏ** là mẫu tùy chọn trong Build Center để kiểm tra pipeline.

## Khả năng hiện có

| Phân hệ | Mã nguồn thực tế |
|---|---|
| Tài khoản | Đăng ký/login/logout, scrypt, phiên server-side, đổi/đặt lại mật khẩu, xác minh và đổi email, hồ sơ công khai, bio/avatar, role hệ thống và quản trị role có version/audit. Token email băm, một lần, có hạn dùng; xác minh yêu cầu đúng tài khoản đang đăng nhập. |
| Cộng đồng | Bài game/thảo luận, draft/public, tìm kiếm và lọc, phân trang, bình luận/reply, like/bookmark, rating/follow, media, phiên bản game, báo cáo và kiểm duyệt. Nội dung bị ẩn được chặn cả ở API cũ và API mới. |
| Dự án | Private/public, khóa độc lập visibility, task/request/bug, priority/due date/assignment, milestone, dependency/checklist, snapshot phiên bản, health tính từ dữ liệu thật, revision và lịch sử duyệt. Có sao chép kế hoạch, xóa mềm/khôi phục và chính sách xóa vĩnh viễn. |
| Cộng tác | Owner/manager/developer/tester/reviewer/customer/viewer, capability riêng, lời mời, task comment/mention, thông báo và SSE. Stream kiểm tra lại phiên và membership, kết thúc khi quyền bị thu hồi. |
| AI Studio | Xưởng pixel tám bàn, chọn vai trò/project đồng bộ với biểu mẫu AI, tiến độ từ nhiệm vụ thật và lối đi có quyền đến planning/tasks/GitHub/build; intake tạo private project/request task trong transaction; adapter HTTPS streaming OpenAI/Anthropic; queue SQLite, retry/timeout/pause/cancel, lịch sử hội thoại, kế hoạch chờ duyệt trước khi tạo task/dependency. Có tám role và tool calling opt-in bị giới hạn; read tools không đọc filesystem/secret, source/build proposals cần owner duyệt rồi bridge thực thi. |
| Usage/budget | Bảng giá có thời điểm hiệu lực, reservation ngân sách nguyên tử, usage có nguồn, settlement một lần, cảnh báo 50/80/100 và phân tích theo dự án/provider/role/ngày. Chi phí luôn là ước tính, không phải hóa đơn. |
| GitHub | GitHub App phía server, token mã hóa, liên kết/source/diff/PR/webhook; thêm immutable workspace snapshot từ commit/blob đã xác minh, validation build trên đúng source hash và owner gate trước PR. |
| Build | Runner Docker web tĩnh, syntax/test/log/exit/cancel, ZIP/hash/download/release; preview iframe opaque-origin từ bundle thành công với token/session/TTL và CSP sandbox. Mục mẫu thử thu gọn mặc định chứa **Làng Đèn Nhỏ**, dùng để kiểm chứng pipeline Docker/preview; thiết kế game của người dùng bắt đầu từ Studio và dự án riêng. |
| Pixel World | SVG làng gốc, bốn công trình có điều hướng bàn phím, menu thường, world/dashboard, light/dark, reduced motion và responsive. Ảnh nhà mái đỏ, gỗ, cỏ xanh và đường cát do người dùng cung cấp định hướng bảng màu; không sao chép sprite. |
| Vận hành | SQLite migration 001–009, health, graceful shutdown, Docker đóng gói website, online backup/integrity check và test HTTP/SQLite thực. |

Giao diện bổ sung nằm trong các component StudioVillage, Identity, Community, ProjectPlanning, AIWorkspace và panel tích hợp. Trạng thái kiểm chứng giao diện mới được cập nhật theo browser gate, không suy ra từ việc component tồn tại.

## Theo giai đoạn

| Phase | Trạng thái hiện tại | Điều kiện còn thiếu hoặc giới hạn |
|---|---|---|
| 1 — Foundation | Backend đạt và 6 browser checks đạt trong development | SMTP TLS đã kiểm tra với server test cục bộ. Chưa gửi email qua nhà cung cấp bên ngoài và chưa xác nhận cấu hình production. |
| 2 — Community | Backend đạt và 9 browser checks đạt, gồm H.264 MP4 phát sau reload | Chưa xác nhận mọi codec/browser/thiết bị; chưa có malware scanner hay object storage ngoài máy. |
| 3 — Project Management | Backend đạt; cùng Phase4 có 13 browser checks đạt | Đã qua planning/review/snapshot/copy/trash/restore; chưa stress-test nhiều instance. |
| 4 — Team Collaboration | Backend/SSE đạt; cùng Phase3 có 13 browser checks đạt | Invitation production cần mail delivery thật; SSE hiện thuộc một instance SQLite. |
| 5 — AI Studio | Tám role, bounded native tool calling và approval bridge qua full suite 174; browser tool workflow 5/5 đạt với native SSE fixture và Docker thật | Chưa có key/model access để gọi API thật. Không có shell tùy ý hay vòng phát triển/repository execution tổng quát; source/build actions chỉ qua quyền/approval và runner giới hạn. |
| 6 — GitHub Integration | App/proposal/webhook, snapshot và test-before-PR qua full suite 174; Docker kiểm thử thật, GitHub transport fixture | Live App/installation/private key chưa có. UI workspace/PR chưa có gate trình duyệt riêng. Workspace là text snapshot được cấp quyền, không phải checkout có shell/dependency install. End-user OAuth/self-service installation chưa có. |
| 7 — Build Center | Pipeline/preview qua full suite 174 gồm Chromium; Build UI 8, game starter 9 và native tool workflow 5 browser checks đạt | Chưa hỗ trợ framework dependency install/Android/desktop target hoặc object storage. Preview chỉ dùng bundle tự chứa và CSP giới hạn tài nguyên; không phải domain preview riêng hoặc ranh giới mạng tuyệt đối. |
| 8 — AI Usage | Full suite và browser tool workflow xác nhận aggregate nhiều lượt, settlement một lần và giữ usage lượt trước khi lượt sau lỗi | Chưa có lời gọi provider thật, đối soát hóa đơn hay benchmark tải. Usage49/25 trong browser gate là số fixture, không phải usage hoặc chi phí dịch vụ thật. |
| 9 — Pixel World | Điều hướng làng baseline đạt; game làng pixel mới qua keyboard/touch390px, nhặt ba vật phẩm/giao nhiệm vụ/thắng/chơi lại | Game nhỏ một người, chưa lưu tiến độ. Không suy ra mọi panel/thiết bị đã kiểm thử. |
| 10 — Quality & Deployment | Installer/schema9 full suite 174/174 và TypeScript/Vite build đạt;45+5=50 browser checks trên DB mới đạt; draft install/start mới đã lưu | CI remote, production deploy, image Docker phiên bản mới, load test, pentest hoặc restore task mới chưa có. Kết quả image/schema7 được giữ riêng làm lịch sử. |

## Các điều kiện bên ngoài

Nhập key AI, SMTP và cấu hình GitHub App qua environment settings hoặc cơ chế secret được cấp quyền; không gửi giá trị trong chat và không commit chúng. Cần PUBLIC_ORIGIN HTTPS, mail sender hợp lệ, model access và installation quyền tối thiểu để chạy live gate tương ứng. Trạng thái “configured” chỉ cho biết có cấu hình, không chứng minh dịch vụ thật chấp nhận yêu cầu.

Build web cục bộ không cần AI/GitHub key; cần Docker, runner image và cờ BUILD_RUNNER_ENABLED=true. Không mount Docker socket vào public web container chỉ để bật runner.

## Kết quả và thứ tự tiếp tục

Xem [TEST_REPORT.md](TEST_REPORT.md) và [PHASE_GATES.md](PHASE_GATES.md) để phân biệt đạt, lỗi, chưa chạy và bị chặn. Game **Làng Đèn Nhỏ** đã chơi trọn nhiệm vụ qua browser gate và ZIP giải nén trên staticHTTP; vào dự án → **Mã nguồn & build → Build Center → Tạo bản chơi được**. Mở rộng tool/workspace/preview đã qua full suite và browser tool workflow; các dịch vụ AI/GitHub/email live vẫn cần cấu hình được cấp, không thay bằng fixtures.

Source Android không thay đổi trong các phase web. Baseline Android đã qua 15 core checks, 10 offline browser checks, APK build/signature và lint không lỗi (hai warning); chưa chạy thiết bị/Minecraft.

Xưởng Studio mới đã có gate trình duyệt7/7 với dữ liệu thật: tạo yêu cầu→project/task, tám vai trò đồng bộ hai chiều, draft theo project, chuyển planning/tasks/source/build đúng đích qua reload, viewer bị giới hạn và390px. Full suite sau cập nhật vẫn174/174; tổng sáu gate52 + tool5 =57 browser checks. Xem đầu TEST_REPORT cho log mới; số45/50 ở phần lịch sử thuộc bản trước thay đổi Studio.

## Skill GitHub dùng chung trong dự án

AI Studio → chọn dự án → Kỹ năng dùng chung cho AI → Thêm skill từ GitHub. Nhập tên và link đến tệp SKILL.md công khai, chọn các vai trò (mặc định cả tám) và lưu. Chủ dự án đang mở khóa được thêm/bật/tắt/xóa/phân vai; role có quyền source được xem nội dung. Tác vụ mới đính kèm snapshot skill đang bật của vai trò, ngân sách gồm nội dung tham khảo; tác vụ cũ giữ hash/version/nội dung đã dùng. Không tự tải scripts, cài dependency hoặc tăng quyền công cụ theo skill. Nhận GitHub blob/raw đến SKILL.md; tối đa10 skill/project,16KiB/skill,48KiB snapshot mỗi tác vụ. Chưa hỗ trợ private repo hoặc tự đọc các tệp phụ được SKILL.md tham chiếu.
