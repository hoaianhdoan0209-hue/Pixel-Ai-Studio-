# Pixel AI Studio Android — bản nguồn 0.1 mobile

Dự án Android cho chính ứng dụng AI Studio chạy trên điện thoại, có văn phòng pixel tại máy và chế độ tạo Add-On Minecraft Bedrock 1.26. Đây KHÔNG phải APK Minecraft, cũng không phải bản model AI tải về offline.

## Trạng thái bàn giao
- Đã chuẩn bị mã nguồn Android/Java, giao diện cục bộ, bộ điều phối AI và workflow GitHub Actions tạo APK debug có chữ ký debug.
- Chưa có Android SDK/Gradle/JDK compiler đầy đủ tại môi trường tạo dự án, nên CHƯA build ra APK, chưa xác nhận compile/lint, chưa cài thử Android.
- Đã kiểm tra cú pháp JavaScript và chạy 11 kiểm tra Node.js cho điều phối/manifest. Playwright có thư viện nhưng thiếu browser executable; chưa chạy được kiểm tra giao diện qua trình duyệt hoặc WebView Android.
- Đây là bản nguồn cần build và kiểm thử, không đổi đuôi ZIP thành APK. Chỉ coi build thành công khi GitHub Actions hoặc Android Studio trả ra app-debug.apk.

## Phần dùng offline
Văn phòng nhìn từ trên xuống với 7 nhân viên, phòng họp, nhà ăn, lựa chọn nhân viên, đi ăn/họp/về bàn, nhập yêu cầu, đọc đầu ra đã lưu và giữ hàng đợi chạy tại máy. HTML/CSS/JS và font pixel đều đi kèm ứng dụng; không tải giao diện từ CDN.

AI qua API vẫn cần Internet. Khi offline, việc chưa bắt đầu giữ nguyên trong hàng đợi. Khi mạng trở lại, nếu ứng dụng đang mở và đã nhập khóa, bộ điều phối gửi các phần việc đủ đầu vào. Không có model AI offline trong gói.

Ứng dụng không có foreground service: Android có thể dừng WebView hoặc tiến trình khi đóng app/khóa máy/tiết kiệm pin. Không hứa đội AI chạy nền 24/7. Lượt bị ngắt cần bấm Thử lại để tránh tự gửi trùng.

## 7 vai trò và song song
Atlas (Leader), Vera (kiểm duyệt), Milo (thiết kế), Kai (gameplay), Nova (hệ thống), Lumi (mỹ thuật), Echo (nội dung/âm thanh). Hướng dẫn chuyên môn được chuyển từ tài liệu Claude Code Game Studios và quy trình game đã dùng trong bản Windows; giao thức hỏi duyệt CLI không đưa vào app.

Leader lập kế hoạch trước. Thiết kế, mỹ thuật, nội dung và khung hệ thống có thể cùng làm. Gameplay chờ thiết kế; kiểm duyệt sớm đọc thiết kế; Nova tích hợp khi đủ đầu vào, rồi Vera kiểm tra cuối. Mặc định tối đa 3 lượt API đồng thời, chỉnh 1–5. Một nhân viên không nhận hai lượt cùng lúc. Khi 429, tự giảm số lượt đồng thời và chờ. Các trao đổi hiện là bàn giao đầu ra giữa các nhiệm vụ, không phải AI xã hội tự trò chuyện liên tục.

## Kết nối API
Tab API: nhập base URL HTTPS, tên model và khóa, dùng Kiểm tra API (gửi 1 lượt gọi) rồi Lưu cấu hình. Với Gemini có nút điền endpoint https://generativelanguage.googleapis.com/v1beta/openai . Nhập model thực sự được tài khoản cấp quyền. Không cấu hình sẵn khóa hay bảo đảm tài khoản đang là Free Tier.

Khóa chỉ ở RAM trong phiên, không lưu vào localStorage. Endpoint/model và dự án lưu trong vùng dữ liệu WebView riêng. Đóng/mở lại phải nhập khóa. Nội dung dự án và kết quả tiền nhiệm được gửi tới nhà cung cấp ngài đã chọn. Những dự án có endpoint/model khác cấu hình hiện tại giữ chờ, không gửi khóa sang provider khác. Chưa có di chuyển dự án giữa provider trên bản mobile này.

## Chế độ Add-On Bedrock 1.26
Chọn loại Minecraft Bedrock 1.26. Đặt tên và mô tả add-on muốn làm; ví dụ công thức chế tạo dùng vật phẩm/texture vanilla.

Các nhân viên được yêu cầu xuất Behavior Pack trong BP/, Resource Pack trong RP/, manifest 2, min_engine_version [1,26,0], UUID cố định theo dự án và dependency đúng giữa hai pack. Phiên bản giao diện Minecraft có thể hiện 26.x; tài liệu creator vẫn dùng 1.26.xx trong JSON/API.

Sau khi Nova hoàn thành phần integrate: tab Sản phẩm → chọn dự án → Kiểm tra & lưu .mcaddon. Bộ kiểm tra đọc JSON, manifest, UUID không trùng, phiên bản và liên kết pack. Chỉ khi đạt cấu trúc cơ bản mới mở trình lưu tệp Android.

Phần native đóng BP và RP thành hai .mcpack riêng, gói tiếp thành .mcaddon. Chọn nơi lưu bằng trình chọn tệp hệ thống. Sau khi có bản APK hoạt động và xuất file: nhập .mcaddon vào bản Minecraft của ngài, bật các pack trong world và kiểm tra thực tế. Chưa chạy Minecraft ở môi trường tạo mã.

Giới hạn bản đầu: chỉ đóng gói file text JSON/JS/lang/mcfunction/txt; chưa sinh PNG/OGG hoặc đính kèm tài nguyên binary. Prompt ưu tiên tài nguyên/âm thanh có sẵn. Script API chưa được bộ kiểm tra xác minh nên hiện bị chặn xuất; các add-on component/recipe cơ bản là mục tiêu đầu tiên. Kiểm tra cấu trúc không xác nhận schema từng component hay gameplay tương thích hoàn toàn.

## Build trên GitHub
1. Đưa toàn bộ NỘI DUNG thư mục này vào gốc một repository dành cho AI Studio. app/, build.gradle, settings.gradle và .github/ phải ở gốc repository.
2. Actions → Build Android APK → Run workflow.
3. Workflow dùng Java 17, Android SDK 35, Android Gradle Plugin 8.9.2 và Gradle 8.11.1. Chạy 11 kiểm tra Node, assembleDebug và lintDebug.
4. Chỉ khi workflow thành công mới tải artifact Pixel-AI-Studio-debug-APK. Bên trong là app-debug.apk để thử cài.

Workflow sử dụng GitHub Actions và tải dependency build từ Google/Maven/Gradle. Việc build cần mạng; ứng dụng sau khi cài không cần mạng để mở văn phòng. Gói này chưa chứa release keystore hay APK phát hành có chữ ký riêng của ngài.

## Build tại máy
Mở dự án bằng Android Studio với JDK 17 và SDK 35, đồng bộ Gradle 8.11.1, chạy assembleDebug. Không có Gradle Wrapper binary trong gói, nên cần Android Studio hoặc Gradle 8.11.1 đã cài. Kết quả app/build/outputs/apk/debug/app-debug.apk.

## Kiểm tra phần lõi
node tests.mjs

11 kiểm tra: URL HTTPS và chuẩn hóa endpoint, chặn đường dẫn file vượt thư mục, các nhánh AI đồng thời, thứ tự phụ thuộc và bàn giao tổ tiên, hoàn thành 9 phần việc, chờ quota và giảm concurrency, phục hồi lượt bị ngắt, cô lập cấu hình provider, manifest hợp lệ/lỗi và UUID trùng, prompt Bedrock ưu tiên hơn HTML/Java mod.

## Nguồn
- https://github.com/donchitos/claude-code-game-studios — vai trò/skill chuyển cho app, MIT ở licenses/ClaudeGameStudio-MIT.txt.
- https://github.com/Glitch-Gaming-Platform/AI-Prompts-For-Game-Development — quy trình game tham khảo.
- https://learn.microsoft.com/en-us/minecraft/creator/documents/update1.26.0?view=minecraft-bedrock-stable
- https://learn.microsoft.com/en-us/minecraft/creator/reference/content/addonsreference/packmanifest?view=minecraft-bedrock-stable
- https://learn.microsoft.com/en-us/minecraft/creator/documents/minecraftfileextensions?view=minecraft-bedrock-stable
- https://developer.android.com/build/releases/agp-8-9-0-release-notes
- https://developer.android.com/develop/ui/views/layout/webapps/load-local-content
Font Pixel Workshop dẫn xuất raster từ DejaVu Sans Mono, xem app/src/main/assets/FONT_LICENSE.txt.
