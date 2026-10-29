# Chạy và triển khai

Website ở web/; Android vẫn dùng Gradle tại gốc checkout. Đây là hướng dẫn local/đóng gói, chưa có public production deployment.

## Điều kiện và lệnh cơ bản

Node.js 24.x, npm và thư mục DATA_DIR ghi được. SQLite chỉ dùng một app/worker instance. Đăng ký, cộng đồng, dự án không cần AI/GitHub key. Bộ test runner thực cần Docker và image node:24-bookworm-slim đã có; preview backend tests cần Python Playwright và Chromium. Runtime website thông thường không cần Docker khi runner tắt.

```sh
cd web
npm ci
export DATA_DIR=/absolute/writable/path/pixel-world-data
npm run dev
```

API mặc định bind 127.0.0.1:3001, Vite 127.0.0.1:5173. API_TARGET cho phép Vite proxy sang API port khác; proxy giữ Host để CSRF Origin check đúng. Không chạy dev server làm production server.

```sh
npm test
npm run build
node ../tests.mjs
```

Bản build chạy cùng-origin với API:

```sh
npm run build
export DATA_DIR=/absolute/writable/path/pixel-world-data
npm start
```

npm start đặt NODE_ENV=production. Health phải trả status=ok, database=sqlite và schemaVersion=9; kiểm tra thêm HTML và một functional workflow. Open port/PID chưa đủ. Startup tự áp dụng migration theo version; backup trước khi nâng cấp DB có dữ liệu.

## Cấu hình

Ứng dụng không tự đọc .env. web/.env.example mô tả tên biến; export hoặc inject từ dịch vụ/container. Không commit hoặc gửi giá trị credential qua chat.

| Biến | Ý nghĩa |
|---|---|
| PORT / HOST / DATA_DIR | Port, bind address và thư mục DB/media/artifact; mặc định port 3001, loopback, var theo working directory. |
| API_TARGET | Target API cho Vite khi phát triển trên port khác. |
| BOOTSTRAP_ADMIN | Chỉ true bật admin cho account đầu tiên trên DB mới. Bootstrap riêng rồi tắt. Không có mật khẩu mặc định. |
| PUBLIC_ORIGIN / COOKIE_SECURE | Origin HTTPS chuẩn và cookie Secure cho production. |
| REQUIRE_VERIFIED_EMAIL | Production mặc định yêu cầu email proof trước khi nhận lời mời; true bật yêu cầu này trong dev QA. |
| MAIL_MODE | file chỉ dành development opt-in; disabled/unconfigured không giả đã gửi mail. |
| SMTP_HOST / SMTP_PORT / SMTP_FROM | Host, port, sender hợp lệ. SMTP_PORT mặc định 465. |
| SMTP_USER / SMTP_PASS | Cặp authentication nếu provider cần; cung cấp qua cấu hình an toàn. |
| SMTP_SECURE / SMTP_CA_FILE | Implicit TLS cho port tùy chỉnh hoặc CA tin cậy; không vô hiệu hóa certificate verification. |
| AI_API_KEY / ANTHROPIC_API_KEY | Credential OpenAI/Anthropic server-side cho host HTTPS cố định; cần model access. |
| GH_APP_ID / GH_APP_PRIVATE_KEY / GH_WEBHOOK_SECRET | GitHub App, PEM private key và secret xác minh webhook. |
| APP_ENCRYPTION_KEY | Key 32 byte, dạng hex hoặc base64, dùng mã hóa token GitHub; cấp qua secret configuration, không có default. |
| BUILD_RUNNER_ENABLED / BUILD_RUNNER_IMAGE | Runner opt-in true; image mặc định node:24-bookworm-slim phải có sẵn. Không tự tải dependency/framework trong job. |
| NODE_USE_ENV_PROXY | Đặt 1 khi Node 24 cần dùng egress proxy đã được môi trường cấp. |

Key GitHub App/khóa mã hóa cần giá trị thực trong process để ký/mã hóa; không thay bằng proxy placeholder. Không tái sử dụng Git proxy/token của onboarding làm quyền cho website users. Trạng thái configured không xác nhận một lượt gọi dịch vụ thật.

## Mail development và kiểm thử

Dev có thể đặt MAIL_MODE=file và PUBLIC_ORIGIN loopback. Email được ghi private dưới DATA_DIR/mail-outbox; không có API xem outbox. Helper QA đọc file cục bộ của chính test để đi qua link một lần. Không dùng file mode trong production.

Các helper tại web/e2e dùng database QA riêng; không chạy chúng vào database của người dùng. Browser gate mới được báo trong [PHASE_GATES.md](PHASE_GATES.md). Khi nhiều agent sửa backend, dùng API non-watch để tránh restart giữa test.

Từ web/, runner E2E tự tạo thư mục QA có marker, dùng API/Vite port riêng và dừng process sau test:

```sh
npm run e2e
npm run e2e -- phase_identity community projects builds
npm run e2e -- playable
python3 e2e/tool_workflow.py
```

Lệnh mặc định chọn identity/community/projects/builds/playable và cần Docker/image đã có; có thể truyền danh sách gate để chạy tập con. Cần Python Playwright 1.62.0, Chromium và ffmpeg để tạo clip video test thật. CHROMIUM_EXECUTABLE chọn browser binary; E2E_ARTIFACTS_DIR đổi thư mục evidence; E2E_API_PORT/E2E_WEB_PORT đổi port test. Helper từ chối port 3001 và dữ liệu runtime không được đánh dấu QA. Script test backend loại credential/operator mail config khỏi subprocess để contract tests không vô tình gọi dịch vụ thật.

`tool_workflow.py` tự tạo test app và frontend trên port riêng3202/5373, native OpenAI SSE fixture được inject rõ ràng, không cần AI key hoặc gọi provider thật. Gate đi qua owner approval, Docker thực, artifact và playable iframe. Không chạy helper fixture trên runtime người dùng. Cài browser trước `npm test`: suite preview cũng dùng Chromium thực và không âm thầm skip khi thiếu dependency.

Workflow .github/workflows/web-quality.yml đã được bổ sung để cài dependency, chạy test/build/audit và browser gates. Chưa có bằng chứng workflow đó đã chạy thành công trên GitHub Actions; local execution được ghi riêng trong test report.

Production cần SMTP TLS/provider thật, sender và origin HTTPS hợp lệ. Local TLS SMTP fixture chứng minh code gửi/kiểm tra certificate, không chứng minh tài khoản ngoài đã được cấp quyền.

## AI tools và kiểm thử trước PR

AI job mặc định không được cấp tool. Khi bật, server chỉ cung cấp `read_project`, `read_tasks`, `propose_source_change`, `request_build` trong số vòng/token/byte đã giữ chỗ. Proposal mã/build không tự thực hiện; owner duyệt payload/version bất biến để bridge tạo pending GitHub proposal hoặc queue Docker build. Không có shell hoặc đường dẫn host do model điều khiển. Bật tool là opt-in của job (`toolsEnabled`); duyệt proposal chỉ gửi version, không thay payload tệp tại thời điểm duyệt. Source action chỉ tạo GitHub proposal đang chờ, không tự tạo PR. Nếu process/dịch vụ ngắt giữa side effect, trạng thái uncertain cần kiểm tra theo action/proposal ID, không tự gửi lại.

Trong project Source Code, tạo workspace từ GitHub base commit hoặc local text. Snapshot GitHub lưu base SHA/checksum/manifest và danh sách đường dẫn không được nạp. Đề xuất PR phải được validation trên đúng snapshot+changes, có test JavaScript và build thành công. Base remote thay đổi thì tạo snapshot/validation mới; không ép approve hoặc thay checksum để vượt gate. Local workspace chỉ phục vụ kiểm thử bundle, không cấp phép PR remote.

## Preview

Preview chỉ dành build web tĩnh đã thành công và role có source capability. UI mở route token một lần trong iframe `sandbox=allow-scripts`, `referrerPolicy=no-referrer`; header CSP server ép opaque origin, không bật allow-same-origin. Không mở raw HTML người dùng bằng route static tin cậy. Phiên mặc định15 phút để chơi, giá trị option kiểm thử bị chặn trên30 phút; hết hạn theo TTL/session/quyền và UI đóng frame khi status mất hiệu lực. Restart process làm token RAM mất hiệu lực.

Không cần domain ngoài cho chế độ opaque sandbox hiện tại. Đây không phải preview host riêng hoặc hỗ trợ framework/assets mạng. CSP chặn các luồng tài nguyên/connect/form/popup/worker đã hỗ trợ; không dùng browser preview như ranh giới mạng tuyệt đối. Runner Docker mới có network none. Xem [SECURITY.md](SECURITY.md) và browser evidence mới trước khi công khai tính năng.

## GitHub và AI live gate

GitHub cần App được cài đúng repository, quyền tối thiểu, mapping installation có kiểm tra và webhook HTTPS. UI không tự tạo connection/commit/PR khi thiếu cấu hình. AI cần key/model, bảng giá có hiệu lực và budget trước khi enqueue. Không dùng fixture output để đánh dấu live gate đạt.

Các domain HTTPS cần cho workflow đã triển khai: api.openai.com, api.anthropic.com, api.github.com; giữ các destination đang dùng khác khi bổ sung network policy. SMTP dùng destination/transport của provider đã chọn và cần kiểm tra kết nối riêng sau cấu hình.

## Build Center và Docker website

Build Center khác việc build Docker image của website. Runner chỉ nhận bounded text bundle web tĩnh, kiểm tra syntax/test trong container cô lập rồi tạo ZIP download. Nó không chạy dependency install hoặc Android/framework build. Preview web tĩnh dùng route sandbox riêng sau build; không thực thi HTML trong tài liệu quản trị. Runner đang tắt phải báo rõ, không ghi job thành công.

Game có sẵn **Làng Đèn Nhỏ** dùng bốn tệp HTML/CSS/JavaScript/test tự chứa, không cần AI/GitHub key hoặc tài nguyên ngoài. Đăng nhập, tạo/chọn dự án, mở **Mã nguồn & build → Build Center → Tạo bản chơi được**. Runner phải sẵn sàng và vai trò phải được tạo build; sau khi build/kiểm thử thành công, khung chơi tự mở. Có thể tải ZIP mã nguồn đã kiểm thử, chọn lại build sau reload và mở phiên chơi mới.

Di chuyển bằng WASD, phím mũi tên hoặc các nút trên màn hình. Đến gần hạt sáng, nhấn E/Space hoặc **Tương tác**; tìm đủ ba hạt rồi mang về bậc cửa nhà mái đỏ để thắng. **Chơi lại** bắt đầu lượt mới. Game chưa lưu tiến độ giữa các phiên. Bản ZIP đã được giải nén và chơi trọn nhiệm vụ qua static HTTP server riêng với mọi request ngoài bị chặn; chưa xác nhận mở trực tiếp `file://` do policy trình duyệt QA từ chối. Xem test report cho gate gameplay của phiên bản hiện tại.

Đóng gói website từ gốc checkout:

```sh
docker build -t pixel-ai-world:local web
docker volume create pixel-world-data
docker run --name pixel-ai-world --rm \
  --publish 127.0.0.1:3001:3001 \
  --mount source=pixel-world-data,target=/data \
  pixel-ai-world:local
```

Container website chạy user node và có API healthcheck. Baseline schema7 đã build và chạy production container thử nghiệm: session/register, Sharp upload/reencode/download, mail unconfigured và runner disabled không có daemon, rồi restart giữ dữ liệu. Container/volume thử nghiệm đã dọn. Không mount Docker socket vào public container; runner cần deployment riêng đã review. Xem test report cho phạm vi.

Cloud build có proxy/CA cần các tùy chọn đã dùng ở baseline, từ web/:

```sh
mapfile -t pixel_docker_proxy < <(python3 - <<'PYCODE'
import os, socket, urllib.parse
proxy = urllib.parse.urlsplit(os.environ['HTTPS_PROXY'])
print(proxy.hostname)
print(socket.gethostbyname(proxy.hostname))
PYCODE
)
DOCKER_CONFIG=/workspace/onboarding-pixel/docker-config docker build \
  --network=host \
  --add-host="${pixel_docker_proxy[0]}:${pixel_docker_proxy[1]}" \
  --build-arg HTTPS_PROXY --build-arg HTTP_PROXY --build-arg NO_PROXY \
  --secret id=extra_ca,src=/usr/local/share/ca-certificates/environment-proxy-ca.crt \
  -t pixel-ai-world:onboarding .
```

Truyền tên biến proxy, không in credential. BuildKit secret thêm CA tin cậy mà không đưa CA/credential riêng vào source/image. Giữ TLS verification.

## Cloud setup và dữ liệu

Dùng checkout có sẵn /workspace/Pixel-Ai-Studio-; mỗi cloud task đã cô lập, không tạo Git worktree nếu người dùng chưa yêu cầu. Khởi tạo toolchain bằng source /workspace/onboarding-pixel/env.sh khi cần Java 17/SDK35/Gradle8.11.1/npm cache. Processes/streams không được giữ khi restore snapshot.

Bản draft mới đã được tool xác nhận lưu `install_script`/`start_skill` cho schema9,174 backend tests và45+5=50 browser checks, game starter/preview 15 phút, tám role/tools/source bridge và Python venv/Playwright prerequisite. Network và requirement metadata khác được giữ nguyên; các yêu cầu biến/secret chỉ ghi tên, không chứa giá trị credential trong source. Draft còn cần người dùng review/save trong environment settings rồi publish; lưu draft không tự chạy script, restart, publish hoặc chứng minh restore ở task mới. Current-instance runtime đã restart schema9 sau backup, integrity/FK đạt, không seed account/post. Website Docker image mới chưa rebuild; bằng chứng image/schema7 ở trên là lịch sử. Xem [TEST_REPORT.md](TEST_REPORT.md).

Backup nhất quán từ web/:

```sh
DATA_DIR=/absolute/path/pixel-world-data npm run backup -- /secure/backups/new-file.sqlite
```

Đích phải chưa tồn tại. Script dùng online backup, mode 0600 và integrity check. Backup DB không bao gồm media/artifact/workspace; sao lưu các thư mục đó riêng. Kiểm thử restore ở thư mục tách biệt và dừng server trước khi thay runtime DB. Chưa có backup scheduler hoặc disaster recovery production.

## Sử dụng làng Studio thiết kế game

Trang chủ → Vào Studio thiết kế game → Tạo yêu cầu game. Yêu cầu được lưu và tạo private project/task trước khi gọi AI. Chọn dự án và một trong tám bàn để soạn tác vụ; biểu mẫu dùng cùng project/role. Các nút kế hoạch/cộng tác/mã nguồn/build mở đúng dự án và giữ đích qua reload. Vai trò xem không có quyền vào source/build/AI riêng. Mẫu Làng Đèn Nhỏ nằm trong mục thu gọn thử pipeline của Build Center.

Publish môi trường onboarding lưu môi trường phát triển; thao tác đó chưa triển khai website công khai. Các đường dẫn /workspace là nội bộ, không phải liên kết tải tệp đính kèm chat. Phiên hiện tại không cung cấp công cụ upload/attachment; không công bố ZIP nội bộ như đã giao được tệp.
