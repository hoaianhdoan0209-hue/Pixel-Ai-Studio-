# Pixel AI World

A Vietnamese community and project workspace built alongside the original Android app. See [the feature status](../docs/FEATURE_STATUS.md) for implemented features and remaining work from the master prompt.

Requires Node.js 24. The development database is SQLite, persisted on disk; it is not PostgreSQL and must not be shared across multiple server instances.

```sh
cd web
npm ci
npm run dev
```

The Vite development server forwards `/api` to the Express API on port 3001. For a production bundle served by the API:

```sh
npm run build
npm start
```

Set `DATA_DIR` to an absolute writable directory to keep your database across restarts. The default local data directory is ignored by Git. Never commit databases, session cookies, passwords or provider keys.

Pixel AI World is a village for designing and developing games. Open AI Studio to create a game brief, select a project and choose one of eight workstations. The chosen project and role feed the actual AI request form. Workshop progress comes from project tasks; links open planning, collaboration, GitHub source and Build Center for that same project. Selecting a desk does not submit an AI job. External provider calls still require server configuration, a model and project budget.

The optional **Mẫu game để kiểm tra pipeline** section in Build Center contains a bundled example. To play **Làng Đèn Nhỏ**, enable the configured Docker runner, sign in, create a project and open **Mã nguồn & build → Build Center → Tạo bản chơi được**. The bundled game runs its actual gameplay tests before opening automatically in an isolated iframe. Move with WASD/arrows or touch controls, collect three sparks with E/Space/**Tương tác**, then deliver them to the cottage. You can replay and download the self-contained HTML/CSS/JavaScript ZIP. This starter needs no AI or GitHub credentials. Play sessions last 15 minutes and can be reopened.

```sh
npm test
npm run e2e
python3 e2e/tool_workflow.py
node ../tests.mjs
```

Accounts are ordinary members by default. To create the initial administrator, start a fresh installation privately with `BOOTSTRAP_ADMIN=true`, register its first account, then restart without that setting before allowing other users. Email verification/password recovery, community media/moderation, project planning/collaboration, eight AI roles with opt-in bounded native tools, GitHub source snapshots and owner-approved proposals, and a Docker static-web build runner are implemented. External SMTP, AI and GitHub require your own secure configuration; live service verification is recorded separately from fixture tests. Source proposals require passing tests against an immutable snapshot before an owner can approve a branch/PR. Arbitrary host tool execution is unavailable.

`npm test` isolates credentials before running backend tests, including real Docker execution, a TLS SMTP fixture and Chromium preview isolation. Python Playwright 1.62 and Chromium must be available before this suite. `npm run e2e` also requires FFmpeg and Docker with `node:24-bookworm-slim`; it starts its own services and temporary database on ports 3102/5273, refuses occupied ports, and runs identity, community, project, build, Studio-workflow and playable-game browser gates. The separate tool workflow starts an explicitly injected protocol fixture on ports 3202/5373 and executes the actual Docker approval bridge. Set `CHROMIUM_EXECUTABLE` if Chromium is not at `/usr/bin/chromium`. Test evidence is written to ignored `.e2e-artifacts/`; the normal runtime database is never populated by the launchers. Local CI commands are defined in `.github/workflows/web-quality.yml`; no remote Actions run is implied.

The default server leaves build execution off. Set `BUILD_RUNNER_ENABLED=true` only where the limited Docker runner is configured. It supports static HTML/JavaScript ZIP artifacts, syntax checks and bounded JavaScript tests; Android and framework-dependent user builds are not supported by this runner. Production mail requires SMTP and a trusted HTTPS `PUBLIC_ORIGIN`. Explicit `MAIL_MODE=file` writes private test messages only outside production.

See [deployment](../docs/DEPLOYMENT.md), [security](../docs/SECURITY.md), and [test evidence](../docs/TEST_REPORT.md) before deploying. Production publication remains a separate action.
