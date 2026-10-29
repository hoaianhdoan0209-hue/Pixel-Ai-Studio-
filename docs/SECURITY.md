# Bảo mật

Các guard nằm ở backend, không dựa vào việc ẩn nút. Đây là mô tả implementation và kết quả test được ghi tại [TEST_REPORT.md](TEST_REPORT.md), không phải chứng nhận production hay pentest độc lập.

## Identity và session

Mật khẩu băm scrypt với salt ngẫu nhiên; session token 256 bit chỉ lưu SHA-256 trong DB. Cookie HttpOnly/SameSite=Lax, có hạn dùng; COOKIE_SECURE=true khi HTTPS production. Logout/revoke xóa session server-side; password reset thu hồi mọi session, đổi mật khẩu thu hồi các session khác.

Token xác minh/reset được băm, có purpose, expiry, delivery state và consumption state. Không trả token/link qua API hoặc log. Verification yêu cầu token thuộc đúng account đang đăng nhập; không dùng token của account khác để chứng minh email. Reset là capability link một lần. Đổi email đòi mật khẩu hiện tại và mất proof cũ. Request reset cho email không tồn tại dùng thông báo chung; có rate limit theo IP/account.

PUBLIC_ORIGIN phải là origin tin cậy: HTTPS, hoặc loopback HTTP ngoài production. Không tạo mail link từ Host tùy ý. MAIL_MODE=file chỉ là opt-in cho development, ghi file private mode 0600 dưới DATA_DIR/mail-outbox và không có endpoint đọc outbox. Không dùng mode này như SMTP production.

SMTP dùng implicit TLS hoặc required STARTTLS, giữ kiểm chứng certificate; SMTP_CA_FILE thêm CA tin cậy khi cần, không tắt verification. TLS SMTP fixture đã chạy thật cục bộ. Chưa xác nhận tài khoản/sender/destination của nhà cung cấp email bên ngoài.

Registration mặc định chỉ member. Admin đầu tiên cần BOOTSTRAP_ADMIN=true trên instance riêng rồi tắt cờ. Role hệ thống có registry; cập nhật admin có version/audit, không cho tự tăng quyền hoặc xóa admin cuối. System admin không tự được đọc private project.

## HTTP, dữ liệu và SSE

- Zod validation, SQL có tham số, JSON body 256 KiB, giới hạn chuỗi/path/URL; React render nội dung như text.
- Helmet/CSP giới hạn origin; tài liệu ứng dụng chính có `frame-ancestors none`, chỉ cho iframe cùng origin để nạp route preview có CSP sandbox riêng. Object bị chặn. HTML upload không được phục vụ như tài liệu tin cậy.
- Mutation kiểm tra Origin/Host hoặc PUBLIC_ORIGIN, từ chối cross-site; JSON và SameSite hỗ trợ CSRF guard. Webhook GitHub là ngoại lệ riêng có HMAC raw-body.
- Role/capability dự án đọc từ DB; lock và privacy độc lập. Update có version trả 409 khi stale. SQL triggers bảo vệ dependency/checklist ngay cả khi đi qua legacy task API.
- Invitation production mặc định yêu cầu email đã xác minh. Development có thể cấu hình REQUIRE_VERIFIED_EMAIL; không dùng cờ bỏ qua để tuyên bố đã kiểm chứng email.
- Project/notification SSE kiểm tra lại session expiry, membership/deletion, kể cả khi public project bị thu hồi membership. Có giới hạn số stream, thời gian, heartbeat/backpressure; logout/revoke làm stream kết thúc.

Rate-limit counters chủ yếu trong RAM của một process; không phải distributed anti-spam. Audit là bảng hoạt động, chưa phải append-only storage chống sửa đổi.

## Media và quyền nội dung

Upload chỉ nhận JPEG/PNG/WebP, MP4/WebM, UTF-8 TXT/JSON và ZIP được kiểm tra định dạng. Ảnh được decode/reencode WebP, giới hạn kích thước pixel và loại metadata; không chấp nhận SVG/HTML/script upload. ZIP được kiểm tra central directory/path/symlink/encryption/bomb constraints, không giải nén trên server.

Giới hạn hiện tại: tổng upload tối đa 25 MiB, ảnh 5 MiB, text 1 MiB, quota account 100 MiB. Storage name ngẫu nhiên, không dùng path client. Owner mới được ghi/xóa; draft/hidden media không tự công khai. File download dùng attachment, nosniff và CSP sandbox. Không có malware scanner; magic check video không phải kiểm chứng mọi codec/playback.

## Quyền source, AI và budget

Public project không cấp quyền repository/source hoặc build riêng. Capability nguồn/build được xét riêng cho owner/manager/developer/tester/reviewer; release artifact chỉ public sau hành động publish rõ ràng của owner.

OpenAI/Anthropic transport chỉ gọi HTTPS host cố định, không theo redirect, kiểm tra kết thúc stream và giới hạn timeout/retry. Key ở server/runtime, không localStorage hoặc response. Có tám role và tool calling có opt-in cho từng job. Tool chỉ đọc tóm tắt/task của project hiện tại hoặc lưu đề xuất mã/build; mọi thao tác nhạy cảm cần owner duyệt bằng version hiện tại. Runtime kiểm tra lại quyền, lock, trạng thái job và hash payload; không nhận shell, đường dẫn host hay credential từ model. Status công bố `toolCalling:true`, `codeExecution:false`: không có thực thi host tùy ý; bridge được cấp quyền chỉ tạo proposal hoặc build Docker giới hạn sau approval.

Job dùng tool giữ chỗ cho toàn bộ số lượt provider được chặn trên, gồm tool definition, kết quả tool và lịch sử message có giới hạn byte. Reservation bao gồm job đang chạy và settlement một lần. Lượt sau bị provider từ chối không được xóa usage đã báo của các lượt trước; lượt đang gọi có kết quả chưa chắc chắn dùng dự trù bảo thủ. Khi provider không báo usage, provenance ghi rõ và dùng reservation bảo thủ; không biến estimate thành token thực tế. Giá nội bộ có hiệu lực theo thời điểm, chi phí là ước tính; reservation không bảo đảm hóa đơn không thể vượt mọi hạn mức ngoài hệ thống.

AI job list/detail/stream chứa prompt, mã và tool arguments chỉ dành role có `viewSource`; viewer/customer không được đọc chỉ vì là project member. SSE kiểm tra lại role và session để việc downgrade không tiếp tục làm lộ source. Log tool loại key nhạy cảm và credential pattern; đây không thay trách nhiệm tránh đưa secret vào yêu cầu.

## GitHub App

App JWT RS256, installation token cache mã hóa AES-256-GCM với key 32 byte; không lưu token plaintext. Request chỉ đến api.github.com, có timeout/body limit và không redirect. Admin website cấp mapping user/installation sau kiểm tra bằng App API; đây chưa phải end-user OAuth hoặc self-service chứng minh ownership GitHub.

Proposal cần owner duyệt trước thao tác tạo nhánh/commit/PR. Gate mới yêu cầu workspace GitHub đúng repository/base, source hash và validation build thành công khớp payload; phải có tệp JavaScript test. Trước side effect kiểm tra lại base SHA và quyền/lock. Build lỗi/đang chờ hoặc base thay đổi không được tạo PR. Không force-push hoặc cập nhật protected/default branch. Webhook dùng HMAC-SHA256 raw-body, timing-safe comparison và delivery ID unique; hiện ghi event/activity, chưa phải đồng bộ commit/CI hoàn chỉnh. Workspace lấy snapshot text bất biến qua GitHub HTTPS API và xác minh SHA-1 Git blob, không clone checkout/credential vào host shell. Từ chối symlink/submodule, path traversal, dotfile/cấu hình riêng/key file và nội dung không hỗ trợ; các file bị bỏ qua được ghi trong manifest. Snapshot local không dùng để chứng minh quyền/commit GitHub. Chỉ bundle web tĩnh có test phù hợp được validation; không suy ra kiểm thử toàn repository/framework.

## Docker runner

Runner opt-in, không nhận host command từ HTTP. Nó chạy fixed syntax checks và các file JavaScript test do project cung cấp trong container giới hạn: network none, user 65534, root/source/control read-only, cap-drop ALL, no-new-privileges, 256 MiB RAM, 1 CPU, 64 PIDs và tmpfs giới hạn. Không đưa host directory, Docker socket, credential hoặc environment của web server vào runner. Input chuyển qua Docker API vào private volumes; cleanup container/volume sau job.

Có timeout, log cap, cancel và quota snapshot/artifact. Bundle web tĩnh được kiểm tra rồi đóng thành source ZIP/hash; không build arbitrary framework. Preview được cung cấp qua route riêng có CSP sandbox ép opaque origin, không coi origin ứng dụng chính là quyền của code game. JSON HTTP limit 256 KiB thấp hơn giới hạn nội bộ source validator; không hứa API nhận trọn 1 MiB JSON bundle.

Backend điều khiển Docker là thành phần có đặc quyền. Trước public deployment cần runner service/host chuyên biệt và mô hình cô lập được review; không mount socket vào public web container để tiện triển khai.

## Preview web tĩnh

Chỉ bundle của build `succeeded` được cấp preview. Token ngẫu nhiên chỉ lưu hash trong RAM, một lần, mặc định15 phút và gắn đúng user/session/build/source hash; option TTL bị chặn trên30 phút. Launch/status kiểm tra lại session, membership và source capability; route nội dung chỉ nhận fetch metadata iframe cùng-origin, không nhận navigation trực tiếp như trang ứng dụng.

HTML được parse/serialize bằng parse5; script/CSS phải nằm trong bundle, remote URL/network hints/meta refresh và phần tử nhúng bị loại bỏ. Header CSP ép `sandbox allow-scripts` mà không `allow-same-origin`, chặn connect/frame/worker/object/form và chỉ cho ảnh/media/font dạng data/blob được giới hạn. Main document chặn framing; iframe UI cũng dùng sandbox và no-referrer. Focused browser test đã kiểm tra gameplay, opaque origin và các bề mặt cookie/localStorage/parent/fetch/worker/popup/form/navigation được nêu trong test. CSP không phải ranh giới mạng tuyệt đối cho mọi giao thức/tính năng browser; kiểm thử cần network isolation tuyệt đối phải chạy trong Docker runner.

Token expiry/revocation ngăn launch tiếp và UI phải đóng iframe theo status. Không tuyên bố có thể thu hồi ngược byte/code đã được browser tải. Đây chưa phải domain preview riêng hoặc cơ chế giới hạn CPU/RAM của code trên thiết bị khách; không dùng để chạy dependency/framework/Android tùy ý.

## Điều kiện trước production

Cần HTTPS/origin/cookie đúng, delivery/provider/App thật đã kiểm chứng, volume và backup cả DB/media/artifact, cấu hình runner riêng, monitoring và security review theo deployment thực tế. Chưa có distributed rate limiting, antivirus, preview host/domain riêng, automatic backup scheduler, load test, pentest hoặc disaster recovery production. Không xem fixture protocol hay QA trên máy hiện tại là bằng chứng các điều kiện đó đã đạt.
