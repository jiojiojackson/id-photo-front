# DEV_STATE

当前开发分支：`agent/queue-worker-bridge`

目标是把证件照前端实现为 Vercel + Neon + R2 + Vercel Queue + Lightning 的“提交任务 / 开始处理分离”架构：提交时创建 Job 并进入 Queue，不启动 Lightning；用户点击开始后创建 Worker Run、短期 Worker Credential，并唤醒 Lightning；Lightning 在一个 Worker Run 内只加载一次模型并串行处理 Job。

## 已完成

- Next.js 前端、Neon/Postgres Job 数据模型。
- Vercel Queue publishing + PollingQueueClient。
- `DATABASE_URL` 由 Vercel 环境变量读取。
- R2 SigV4 server-side PUT：提交时直接上传原图，不再生成 PUT presigned URL。
- processing 用 R2 presigned GET/PUT URL 延迟到 Worker `next` claim 成功之后生成。
- `photo_worker_runs` + `photo_worker_state`。
- 开始处理的服务端原子并发保护。
- 短期 Worker Credential：Vercel 生成随机 credential，只在 Neon 保存 hash，默认有效 4 小时。
- Vercel 唤醒 Lightning 时传递 `worker_run_id`、`bridge_url`、短期 credential 和过期时间。
- Lightning 应用不需要配置 `LIGHTNING_*`、R2、Database、Queue 等项目环境变量；这些只存在 Vercel。
- Queue Bridge：`next` / `heartbeat` / `complete` / `fail` / `finish`。
- Job claim 使用数据库事务 + `FOR UPDATE SKIP LOCKED`，支持 queued 和 lease 已过期的 processing Job。
- Job lease、attempt_count、worker_run_id、claimed_at、lease_expires_at。
- complete/fail 使用 worker + lease 条件保护旧 Worker，complete 支持幂等。
- Worker 崩溃后，下一次 `/api/jobs/start` 可恢复 lease 已过期 Job。
- 数据库 Migration 自动化：`db/migrations/001_initial.sql` + `scripts/migrate.mjs`。
- Vercel 使用 `vercel-build`：先执行 `npm run db:migrate`，成功后才执行 `next build`。
- Migration 使用 `schema_migrations` 记录版本，并使用 PostgreSQL advisory lock 防止并发部署重复执行。
- `db/schema.sql` 现在仅作为 bootstrap/reference 文档；生产数据库由 migration history 管理。

## 后端最新进度

`id-photo-back` 当前分支：`agent/queue-worker-bridge`。

后端已按照当前 Frontend Bridge Contract 实现 Lightning Worker，并保留 Draft PR #2，尚未合并 `main`。

后端目前已经实现：

- `/process-queue` 接收 Vercel wake payload。
- 正式支持前端使用的 snake_case：`worker_run_id`、`bridge_url`、`worker_credential`。
- 同时暂时兼容 camelCase payload。
- Worker 使用短期 Worker Credential 作为 Bearer Token 调用 Vercel Bridge。
- 一个 Worker Run 内串行处理 Job。
- `IDCreator` 在进程启动时初始化，不会每个 Job 重复加载模型。
- `next → R2 input GET → GPU inference → R2 output PUT → complete/fail`。
- 推理期间每 60 秒 heartbeat。
- Queue 空后调用 `finish`。
- 单 Job 失败后回调 `fail` 并继续处理后续 Job。
- 保留 `/generate` 同步 API 作为单张图片手动/回归测试接口。
- Lightning 后端不依赖项目级 `LIGHTNING_*`、Database、R2、Queue 环境变量。

## 联合调试最新进度

### 2026-08-15：Wake URL 已修复

首次真实联调确认 `LIGHTNING_API_URL` 指向 `/`，导致 `POST / → 405 Method Not Allowed`。前端现已自动把 `LIGHTNING_API_URL` 规范化为 `POST ${LIGHTNING_API_URL}/process-queue`。

随后 Lightning 日志已经确认：

```text
POST /process-queue HTTP/1.1 200 OK
```

因此 Wake 阶段已通过。

### 2026-08-15：Worker Credential 401

Lightning 随后调用 Vercel `/api/worker/next`，返回 401，Lightning 日志为：

```text
[QueueWorker] stopped unexpectedly run=22647145-611a-4856-be52-45abffca0f00: worker credential is invalid or expired
[QueueWorker] stopped run=22647145-611a-4856-be52-45abffca0f00 processed=0
```

此前已加入不泄露 secret 的认证诊断日志。当前为了避免 Lightning 平台本身的唤醒/部署延迟，联合调试方案临时切换为 **Lightning Studio Linux 服务器直接运行 FastAPI**，不使用 Docker、不使用 Lightning 平台 API Key。

## 当前调试模式：Lightning Studio Linux 直接运行

### 目的

调试阶段暂时不经过 Lightning 平台的实例唤醒 API：

```text
Vercel
 ↓
直接 POST Lightning Studio FastAPI /process-queue
 ↓
Worker
 ↓
Vercel Bridge
```

这样可以快速定位 Worker Credential、Bridge、R2、Queue 和 inference 问题。

### 前端调试配置

新增环境变量：

```text
DEBUG_DIRECT_BACKEND=true
LIGHTNING_API_URL=https://<Lightning-Studio-server-public-url>
```

当 `DEBUG_DIRECT_BACKEND=true` 时：

- `LIGHTNING_API_KEY` 不需要配置。
- Vercel 不发送 `Authorization: Bearer <LIGHTNING_API_KEY>`。
- `LIGHTNING_API_URL` 自动追加 `/process-queue`。
- Wake body 仍然包含短期 `worker_credential`，因为这个 credential 是 Lightning Worker 调用 Vercel Bridge 所必需的，与 Lightning 平台 API Key 是两套不同的凭证。

生产模式保持：

```text
DEBUG_DIRECT_BACKEND != true
LIGHTNING_API_URL + LIGHTNING_API_KEY
```

### 后端启动方式

Lightning Studio Linux 服务器上直接运行，不使用 Docker：

```bash
cd /path/to/id-photo-back
python3 -m pip install -r requirements.txt
python3 -m pip install "fastapi[standard]" python-multipart pillow
python3 -m uvicorn api_server:app --host 0.0.0.0 --port 8000
```

如果当前 Studio 环境已经安装依赖，可直接：

```bash
cd /path/to/id-photo-back
python3 -m uvicorn api_server:app --host 0.0.0.0 --port 8000
```

Dockerfile 中原本使用的启动命令也是同一个 Uvicorn ASGI 入口：

```text
uvicorn api_server:app --host 0.0.0.0 --port 8000
```

### 后端测试入口

```text
GET  /health
GET  /
POST /generate
POST /process-queue
```

`/process-queue` 收到 Vercel wake body 后会在后台线程启动 Worker，不阻塞 FastAPI 请求。

### 当前代码变更

Frontend `app/api/jobs/start/route.ts` 已支持 `DEBUG_DIRECT_BACKEND=true`：

- debug 模式只要求 `LIGHTNING_API_URL`。
- production 模式仍要求 `LIGHTNING_API_KEY`。
- debug 模式不发送 Lightning platform Authorization header。
- 保留 `/process-queue` 自动追加逻辑。

当前 Frontend commit：`6357a35ada2f7f1a8401f285f9b377a59fd39478`。

Backend 当前调试分支仍为：`agent/queue-worker-bridge`。

## 当前重要实现约定

### Lightning 无状态 / 调试例外

生产 Lightning 容器不配置项目环境变量。生产 Vercel 使用平台提供的 `LIGHTNING_API_URL` 和 `LIGHTNING_API_KEY` 唤醒 Lightning；短期 Worker Credential 通过请求 body 传递给 Lightning。

调试阶段允许 `DEBUG_DIRECT_BACKEND=true`，Vercel 直接访问 Lightning Studio 上运行的 FastAPI，此时不发送 Lightning 平台 API Key。

### Lightning Wake URL

正式 Worker endpoint 必须是：

```text
POST ${LIGHTNING_API_URL}/process-queue
```

Vercel 代码会在 `LIGHTNING_API_URL` 未包含 `/process-queue` 时自动追加该路径。

### R2 URL 生命周期

提交阶段：

```text
原图 → Vercel SigV4 PUT → R2
```

开始处理之后：

```text
Lightning next
 ↓
Neon claim
 ↓
生成 input GET / output PUT presigned URL
 ↓
返回给 Lightning
```

当前 processing URL 有效期 15 分钟。

### Lease

当前初始 lease 为 10 分钟，heartbeat 可继续延长。这个值还没有经过真实 Lightning p95 / 最大推理时间测试，生产前必须校准。

### Queue ACK

`PollingQueueClient.receive()` 在 handler 返回时 ACK，因此当前实现是在 Bridge 成功 claim Job 后 ACK Queue message，而不是等待 GPU 推理完成。

Neon Job lease 是任务所有权的 source of truth。Worker 崩溃后，lease 到期，下一次 Worker Run 可以重新 claim；不会依赖 Queue message 一直保持未 ACK。

### Database migrations

新的数据库结构必须新增编号 migration，例如 `db/migrations/002_add_xxx.sql`，不要直接修改生产数据库或依赖手动执行 `db/schema.sql`。

## 下一步

1. 在 Lightning Studio Linux 服务器启动 `id-photo-back` 的 FastAPI，不使用 Docker。
2. 为 Vercel Preview 设置 `DEBUG_DIRECT_BACKEND=true` 和 Lightning Studio FastAPI 公网 URL；调试阶段不要设置 `LIGHTNING_API_KEY`。
3. 重新点击“开始处理”。
4. 首先验证 Lightning Studio 日志：`POST /process-queue 200`。
5. 再观察 Worker：`POST Vercel /api/worker/next` 是否不再 401。
6. 如果认证通过，继续调试 `next → R2 → inference → complete → finish`。
7. 联调 1 个 Job 成功后，再测试 3 Job 串行处理。
8. 测试 heartbeat、Worker 崩溃、lease 到期、重复 complete、单 Job fail/retry。
9. 测量实际推理时间后调整 lease、heartbeat 和 presigned URL 有效期。
10. 调试链路稳定后，再切回生产 Lightning 平台 Wake 模式并处理此前的 Credential 401 问题。
11. 最终验证生产链路后，合并 `id-photo-back` Draft PR #2 和 Frontend 分支到 `main`。
