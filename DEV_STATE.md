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

`id-photo-back` 已新增 `agent/queue-worker-bridge` 分支，并创建 Draft PR #2，已经按照当前 Frontend Bridge Contract 实现 Lightning Worker。

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

首次真实联调确认 `LIGHTNING_API_URL` 指向 `/`，导致：

```text
POST / → 405 Method Not Allowed
```

前端现已自动把 `LIGHTNING_API_URL` 规范化为：

```text
POST ${LIGHTNING_API_URL}/process-queue
```

随后 Lightning 日志已经确认：

```text
POST /process-queue HTTP/1.1 200 OK
```

因此 Wake 阶段已通过，Worker 已正式启动。

### 2026-08-15：当前问题为 Worker Credential 401

Lightning 随后立即调用：

```text
POST <Vercel>/api/worker/next
Authorization: Bearer <worker credential>
```

Vercel 返回 `401`，Lightning 日志：

```text
[QueueWorker] stopped unexpectedly run=22647145-611a-4856-be52-45abffca0f00: worker credential is invalid or expired
[QueueWorker] stopped run=22647145-611a-4856-be52-45abffca0f00 processed=0
```

这说明当前已经进入：

```text
Lightning /process-queue 200
        ↓
POST Vercel /api/worker/next
        ↓
401
```

问题范围已缩小到 Worker Credential 的传递、hash、Neon 查询或 `/api/worker/next` 部署版本，不涉及 GPU 推理。

### Credential 当前设计

Vercel：

```text
createWorkerCredential()
 ↓
SHA-256
 ↓
Neon photo_worker_runs.credential_hash
```

同时将原始 credential 放进 Lightning wake body。

Lightning：

```text
Authorization: Bearer <credential>
```

Vercel Bridge：

```text
Bearer token
 ↓
SHA-256
 ↓
credential_hash + expiry + status 校验
```

理论上生成和验证使用同一 SHA-256 实现，因此目前需要通过日志确认实际收到的 token 与 Neon 中的 credential hash 是否匹配。

### 本轮调试代码

前端 `lib/worker-auth.ts` 已加入**不泄露 secret 的诊断日志**：

- Authorization 是否存在
- token 长度
- Neon 中 Worker Run 总数
- `matchingHash`
- `matchingButExpired`
- `matchingButInactive`

不会记录原始 credential 或 hash。

后端 `id-photo-back/api_server.py` 已加入：

- Worker Run 启动时记录 bridge URL、run ID、credential 长度
- `/next` 收到 401 时记录 response body 前 1000 字符
- 不记录 credential 内容

当前相关提交：

- Frontend auth diagnostics：`0337fb026aa7208ebd1cd6c2ccfab9d0b5d6778d`
- Backend diagnostics：`15f86cd49768f8d109b8614fff06c3022a74ca41`

## 当前重要实现约定

### Lightning 无状态

Lightning 容器不配置项目环境变量。Vercel 使用平台提供的 `LIGHTNING_API_URL` 和 `LIGHTNING_API_KEY` 唤醒 Lightning；短期 Worker Credential 通过请求 body 传递给 Lightning。

### Lightning Wake URL

正式调用 endpoint 必须是：

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

1. 部署 Frontend `0337fb026aa7208ebd220?` 对应的最新分支版本以及 Backend `15f86cd49768f8d109b8614fff06c3022a74ca41`。
2. 再点击一次“开始处理”。
3. 首先看 Vercel Runtime Logs 中 `[WorkerAuth] credential rejected` 的四个诊断字段：`tokenLength / matchingHash / matchingButExpired / matchingButInactive`。
4. 同时看 Lightning：`/next unauthorized ... body=...`。
5. 如果 `matchingHash=0`：重点检查 Wake body 中 credential 是否原样传递，以及 Vercel start 与 worker/next 是否连接同一个 Neon 数据库/同一部署。
6. 如果 `matchingHash=1` 且 `matchingButExpired=1`：检查服务器时间、credential TTL 和数据库时间。
7. 如果 `matchingHash=1` 且 `matchingButInactive=1`：检查 Worker Run 是否在 `/next` 到达前被 start/cleanup 逻辑置为 failed/completed。
8. 如果认证通过，继续调试 `next → R2 → inference → complete`。
9. 认证链路稳定后，再补正式 `worker_events` 事件日志；当前诊断日志先用于快速定位 401。
