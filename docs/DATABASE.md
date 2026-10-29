# Database

Website dùng SQLite thực tại DATA_DIR/pixel-world.sqlite, tách khỏi Android WebView/localStorage. Không seed account, post, project, AI output hoặc chỉ số demo vào runtime.

## Migration

server/db.ts bật foreign keys, WAL và busy_timeout=5000. Migration 001 khởi tạo idempotent; các file NNN_name.sql tiếp theo được sắp theo version và chỉ áp dụng khi chưa có trong schema_migrations, mỗi file trong transaction. Mã hiện có migration đến schema 10; trạng thái runtime đã migrate phải được xác nhận bằng health/DB của instance, không suy từ file migration. Thay đổi tiếp theo phải thêm migration; không sửa file đã áp dụng để thay thế migrate dữ liệu.

| Version | Schema |
|---|---|
| 001 | Users/sessions, posts/comments/reactions, projects/members/invitations/tasks, activity/notifications. |
| 002 | customer_requests: questionnaire, người gửi, project và task gốc unique, trạng thái awaiting_provider. |
| 003 | Proof email, bio/avatar, identity version; identity_tokens có token hash unique, purpose, expiry, delivery/consumption state. |
| 004 | Discovery/category/discussion/hidden content; media, ratings, follows, reports, moderation_actions, game_releases. |
| 005 | Mở rộng role project; project_milestones, project_versions, task_dependencies, task_checklists, task_comments, mentions, revisions/reviews và integrity triggers. |
| 006 | Agent/model pricing, budget policy, AI jobs/messages/usage/alerts và task liên kết kế hoạch đã duyệt. |
| 007 | GitHub connection/repository/proposal/webhook; build job và release. |
| 008 | `ai_jobs.agent_role`/`tools_enabled`, cấu hình năm role mở rộng, tool calls và immutable tool proposals có hash/version/trạng thái. |
| 009 | `source_workspaces`; liên kết proposal đến workspace/base commit/validation build/hash; idempotency action ID cho bridge AI→proposal/build. |
| 010 | `project_ai_skills` lưu Markdown/hash/phân vai/version và `ai_jobs.skills_json` giữ snapshot skill đã dùng; dữ liệu cũ có danh sách skill rỗng. |

Migration 005 dựng lại membership/invitation có kiểm soát để thêm tester/reviewer và giữ dữ liệu cũ. Test migration dùng DB v2 có member/invitation/task assignee, kiểm tra foreign keys và mở lại idempotent.

## Ràng buộc và quyền dữ liệu

- User email unique không phân biệt hoa/thường; password scrypt và session SHA-256. identity_tokens không lưu link/token email gốc.
- Like/bookmark/rating/follow có unique composite keys. Report mở không được lặp cùng người/target; target phải là một post hoặc comment. Media có owner, purpose, random storage name, size/mime; byte thực nằm ngoài DB.
- Project visibility, lock và soft-delete là thuộc tính riêng. Membership không tự cấp quyền chỉ vì một người là system admin. Version bắt buộc cho update tương ứng; API trả 409 khi stale.
- Dependency phải cùng project, không self/cycle. Trigger chặn task done khi predecessor hoặc checklist chưa xong và chặn mở lại predecessor của task đã done.
- Project version chứa snapshot bất biến. Clone tạo ID/ownership mới, reset tiến độ/assignment, không sao chép thành viên hay lịch sử duyệt. Purge cần owner, trash đủ thời gian và không giữ lịch sử Studio/AI/build/GitHub/workspace cần bảo toàn. Snapshot source tự nó đủ để chặn purge; không cần có thêm một AI job hoặc build record.
- AI idempotency theo user/key; reservation/settlement trong transaction; usage ghi provenance và giá snapshot. ai_plan_tasks giữ quan hệ job đã duyệt đến task thật. Migration008 thêm `ai_tool_calls` và `ai_tool_proposals`; mỗi job giới hạn tool rounds, source/build proposal chỉ chạy qua bridge sau owner approval. `agent_role` mở rộng tám role nhưng giữ cột legacy `agent` để bảo toàn dữ liệu/schema CHECK cũ.
- GitHub token mã hóa AES-256-GCM trước khi lưu; webhook delivery ID unique. Workspace lưu text manifest bất biến, SHA-256 và base commit; byte text/manifest được ghi dưới DATA_DIR/workspaces bằng tên UUID. Proposal validation phải gắn đúng workspace, source hash và build thành công; action ID unique chống lặp bridge sau retry/restart. Build giữ source text snapshot, trạng thái/log/exit và metadata artifact; ZIP thực nằm trong thư mục artifact.

Các index hỗ trợ feed, owner/membership, task graph, queue, expiry, usage theo project/ngày và artifact. SQLite không tự thực hiện authorization; mọi query công khai đi qua backend guard.

## Transaction và restart

Studio intake, planning/review, role changes, reservation và các cập nhật nhiều bảng dùng transaction. Worker không tự coi công việc đang chạy là đã xong sau restart; kết quả ngoài hệ thống chưa chắc chắn cần hành động rõ ràng trước khi chạy lại. Tool proposal đang `running` khi process dừng chuyển thành `uncertain`; không tự lặp thao tác có thể đã hoàn tất ở hệ thống ngoài. Test phân biệt persistent records với process/connection không được giữ khi khởi động lại. Preview token chỉ ở RAM, gắn session và source hash; restart làm token hết hiệu lực, không có migration riêng cho preview.

## Backup và mở rộng

`npm run backup -- /secure/path/new-backup.sqlite` dùng SQLite online backup, từ chối file/symlink đích đã tồn tại, mode 0600 và integrity_check. Backup DB không sao lưu byte media/artifact/workspace hoặc private file-mail outbox; cần chính sách riêng cho các thư mục đó. Giữ dữ liệu ngoài Git và kiểm thử restore trên bản sao trước khi thay runtime.

Hiện là thiết kế một instance. Chưa có PostgreSQL/Prisma/Redis, object store, queue phân tán hoặc backup scheduler. Đọc [TEST_REPORT.md](TEST_REPORT.md) cho bằng chứng đã chạy; backup QA không thay thế disaster recovery production.
