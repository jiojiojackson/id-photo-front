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

## 当前重要实现约定

### Lightning 无状态

Lightning 容器不配置项目环境变量。Vercel 使用平台提供的 `LIGHTNING_API_URL` 和 `LIGHTNING_API_KEY` 唤醒 Lightning；短期 Worker Credential 通过请求 body 传递给 Lightning。

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

Vercel 部署时：

```text
Git push
 ↓
Vercel build
 ↓
npm run db:migrate
 ↓
schema_migrations 检查版本
 ↓
只执行尚未应用的 migration
 ↓
next build
 ↓
部署
```

如果 migration 失败，Build 失败，避免部署一个代码与数据库结构不匹配的版本。

## 下一步

1. 确认最新 Preview Build 成功，并检查 migration 日志出现 `001_initial applied`（首次部署）或 `001_initial already applied`。
2. 配置/确认 Lightning 的公网 wake endpoint 能把 Vercel wake body 原样交给 `/process-queue`。
3. 真实测试 3 个 Job：提交 → queued → 开始 → Lightning 唤醒 → 依次 claim → R2 输入/输出 → completed。
4. 测试重复点击开始、Worker 崩溃、lease 到期、重复 complete、单 Job fail/retry。
5. 测量实际推理时间后调整 lease、heartbeat 和 presigned URL 有效期。
6. 验证前后端完整生产链路后，合并 `id-photo-back` Draft PR #2 和 Frontend 分支到 `main`。

## 当前未确认

- 尚未完成真实 Lightning 公网 wake endpoint → `/process-queue` 联调。
- 尚未完成真实 Lightning Worker 与 Vercel Bridge 的端到端联调。
- 尚未确认 3 Job 串行处理和 Worker 崩溃恢复的生产结果。
- 尚未根据真实 Lightning p95 / 最大推理时间校准 lease、heartbeat 和 presigned URL。
- 后端目前是 Draft PR，尚未合并到 `main`。
