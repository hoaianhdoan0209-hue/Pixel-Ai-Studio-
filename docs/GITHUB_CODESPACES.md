# Dùng Pixel AI World trên GitHub

GitHub Codespaces chạy cả website, API và SQLite trong môi trường phát triển riêng của bạn. GitHub Pages chỉ phục vụ tệp tĩnh nên không chạy được đầy đủ tài khoản, cộng đồng và dự án của ứng dụng này. Codespaces chưa phải hosting production; thời gian sử dụng và dung lượng tuân theo hạn mức/gói GitHub của tài khoản.

1. Mở nhánh `codex/pixel-ai-world-studio` trong repository.
2. Chọn **Code → Codespaces → Create codespace on codex/pixel-ai-world-studio**. Giữ cấu hình `.devcontainer` của repository.
3. Đợi cài dependency, build website và tải image runner. Sau khi hoàn tất, trang Pixel AI World tự mở. Nếu chưa mở, vào bảng **Ports**, tìm cổng **3001**, chọn **Open in Browser**. Giữ cổng ở chế độ **Private**.
4. Đăng ký tài khoản → **AI Studio → Tạo yêu cầu game**. Chọn dự án và một trong tám bàn AI để soạn yêu cầu. Dữ liệu được lưu thật ở `web/var`; dừng rồi mở lại cùng Codespace vẫn giữ dữ liệu. Xóa Codespace sẽ xóa dữ liệu của nó; tải backup trước khi xóa.

Nếu cần khởi động lại, chạy `bash .devcontainer/start.sh`. Log nằm ở `web/var/codespace-server.log`. Để xem log: `tail -n 80 web/var/codespace-server.log`. Nếu thay đổi frontend, chạy `cd web && npm run build`.

Tài khoản đầu tiên vẫn là member, không tự tăng quyền admin. Có thể dùng cộng đồng, tạo yêu cầu, dự án và task ngay. Nếu cần quản trị, làm theo bootstrap riêng trong DEPLOYMENT.md; không bật bootstrap trên một cổng công khai.

AI cần `AI_API_KEY` hoặc `ANTHROPIC_API_KEY`, model được cấp quyền và ngân sách dự án. Email cần SMTP; lời mời yêu cầu xác minh email. GitHub App của ứng dụng cần cấu hình riêng, khác quyền Git của Codespace. Cấu hình giá trị riêng trong **GitHub Settings → Codespaces → Secrets**, cấp quyền repository rồi khởi động lại Codespace; không nhập key vào chat, mã nguồn hay trình duyệt của ứng dụng. Tên biến và cấu hình xem web/.env.example.

Build runner dùng Docker riêng của Codespace và image Node đã tải. Hỗ trợ HTML/JS tự chứa, kiểm thử và ZIP; chưa hỗ trợ build Android/framework/desktop. Ứng dụng Android gốc được giữ nguyên; Codespace này ưu tiên website và không tự cài Android SDK.

Đã kiểm tra build/script và ứng dụng trong cloud hiện tại. Chưa tạo/chạy Codespace mới trên GitHub, chưa xác nhận remote Actions hoặc website công khai; cần phân biệt các trạng thái này.

## Nếu cổng3001 báo502

502 chỉ xác nhận proxy chưa kết nối được website, chưa xác định nguyên nhân. Trong Terminal ở gốc repository, chạy `git pull --ff-only` rồi `bash .devcontainer/start.sh`. Script mới kiểm tra Node24, chuẩn bị dependency/frontend còn thiếu, khởi động server ở session riêng và in lỗi từ log khi không chạy được. Docker/image không có sẽ tắt runner thay vì chặn cả website.

Nếu báo sai Node, nhấn Ctrl+Shift+P → **Dev Containers: Rebuild Container**, chờ hoàn tất rồi mở lại cổng3001. Nếu vẫn502, kiểm tra `node -v` và `tail -n 40 web/var/codespace-server.log`; không xóa database để khắc phục startup.

Bản sửa đã chạy thử startup mới và startup lặp lại ở cổng3199/data QA riêng, kiểm tra schema9, SPA, đăng ký thực và website hoạt động khi runner tắt. Đây chưa phải xác nhận đã khắc phục Codespace của người dùng; cần log/kiểm tra tại Codespace đó.

## Nhập ý tưởng bằng tiếng Việt

Trong terminal ở gốc repository chạy `git pull --ff-only`, sau đó `npm --prefix web run build`; tải lại trang để nhận giao diện mới. Vào AI Studio → Tạo yêu cầu game, điền tên, mô tả, tính năng và điều kiện nghiệm thu bằng tiếng Việt. Sau khi lưu, chọn dự án/bàn AI và soạn yêu cầu. Nút Điền mẫu tiếng Việt có mẫu theo vai trò; chỉ dùng khi ô yêu cầu còn trống. Chọn mô hình được API cấp quyền, lưu ngân sách rồi chủ động gửi tác vụ. Nếu chưa có bảng giá, quản trị viên cần cấu hình tại Mức sử dụng.

Các thẻ Trợ lý AI/Kết nối mã nguồn GitHub/Máy dựng game là trạng thái dịch vụ. Hướng dẫn nhập khóa nằm trong mục Chưa biết nhập khóa AI ở đâu? ở cuối trang; khóa phải lưu trong Codespaces Secrets với tên AI_API_KEY hoặc ANTHROPIC_API_KEY, chọn đúng repository rồi dừng/mở lại Codespace. Không gửi khóa qua chat.

## Dùng skill GitHub

Cập nhật mã bằng git pull --ff-only và npm --prefix web run build, sau đó dừng rồi mở lại cùng Codespace để máy chủ nhận API mới và tự migrate schema10 (giữ dữ liệu trước đó). Không tạo Codespace khác để cập nhật, vì dữ liệu thuộc Codespace hiện tại. Nên tạo backup SQLite theo DEPLOYMENT.md trước nâng cấp.

Vào AI Studio → chọn dự án → Kỹ năng dùng chung cho AI → Thêm skill từ GitHub. Nhập tên, dán URL của tệp SKILL.md công khai, chọn các AI cần dùng và bấm Đọc và lưu skill. Xem nội dung trước khi gửi tác vụ; skill đang bật tự đi cùng tác vụ của các vai trò đã chọn, không cần bật quyền công cụ. Có thể tắt hoặc xóa skill khỏi tác vụ mới; lịch sử tác vụ cũ giữ bản đã dùng.
