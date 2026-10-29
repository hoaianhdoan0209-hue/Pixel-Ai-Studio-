# Pixel AI Studio

Ứng dụng Android văn phòng pixel với 7 vai trò AI, lưu dự án offline và xuất Add-On Minecraft Bedrock.

Xem [hướng dẫn tiếng Việt](README_VI.md). Tải APK tại tab Actions → Build Android APK → Artifacts.

## Pixel AI World — website

Nền tảng web mới nằm trong [web/](web/README.md), chạy độc lập và giữ nguyên ứng dụng Android. Xem [tình trạng chức năng](docs/FEATURE_STATUS.md), [kiến trúc](docs/ARCHITECTURE.md) và [kết quả kiểm thử](docs/TEST_REPORT.md) để phân biệt các luồng đã triển khai với các phase còn lại của master prompt.

Pixel AI World tập trung vào làng Studio thiết kế game: tám bàn AI, yêu cầu khách hàng, dự án và nhiệm vụ thật, cộng tác, mã nguồn và build trong cùng luồng làm việc. Mẫu game trong Build Center là tài nguyên thử pipeline tùy chọn.

## Mở Studio bằng GitHub Codespaces

Trên nhánh `codex/pixel-ai-world-studio`, chọn **Code → Codespaces → Create codespace**. Đợi thiết lập rồi mở cổng **3001** trong bảng **Ports**. Xem [hướng dẫn từng bước](docs/GITHUB_CODESPACES.md). Đây là môi trường riêng để dùng thử đầy đủ website/API, khác GitHub Pages và hosting production.
