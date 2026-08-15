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
- Queue Bridge：
  - `POST /api/worker/next`
  - `POST /api/worker/heartbeat`
  - `POST /api/worker/complete`
  - `POST /api/worker/fail`
  - `POST /api/worker/finish`
- Job claim 使用数据库事务 + `FOR UPDATE SKIP LOCKED`，支持 queued 和 lease 已过期的 processing Job。
- Job lease、attempt_count、worker_run_id、claimed_at、lease_expires_at。
- complete/fail 使用 worker + lease 条件保护旧 Worker，complete 支持幂等。
- Worker 崩溃后，下一次 `/api/jobs/start` 可恢复 lease 已过期 Job。
- `plan.md` 已同步更新为当前真实架构，并明确 Queue ACK 的实现取舍。

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

## 下一步

1. 最新 Preview Build 通过后，确认 Neon 生产数据库已经执行最新 `db/schema.sql`。
2. 根据 Bridge contract 修改 Lightning Worker：收到短期 credential 后调用 `/next`，串行处理，期间 heartbeat，完成后 `/complete` / `/fail`，empty 后 `/finish`。
3. 测试 3 个 Job：提交 → queued → 开始 → Lightning 唤醒 → 依次 claim → R2 输入/输出 → completed。
4. 测试重复点击开始、Worker 崩溃、lease 到期、重复 complete、单 Job fail/retry。
5. 测量实际推理时间后调整 lease、heartbeat 和 presigned URL 有效期。
6. 端到端生产测试通过后再合并到 `main`。

## 当前未确认

- 尚未确认最新代码已经通过最终 Vercel Build。
- 尚未执行最新 `schema.sql` 到生产 Neon。
- 尚未完成真实 Lightning Worker 与 Bridge 的端到端联调。
- 尚未确认 3 Job 串行处理和 Worker 崩溃恢复的生产结果。
