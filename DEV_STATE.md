# DEV_STATE

当前开发分支：`agent/queue-worker-bridge`

本项目是 Vercel + Neon + R2 + Vercel Queue + Lightning 的异步证件照前端。提交任务与开始处理分离：提交只创建 Job/Queue；点击开始才创建 Worker Run、短期 Worker Credential 并唤醒 Lightning。

## 当前状态

- `/api/jobs/status` 已改为**完全手动刷新**；前端不再设置任何自动 status timer。
- 用户点击“刷新任务状态”时才请求 `/api/jobs/status`。
- `/api/jobs/start` 仍只有在用户明确点击“开始处理”时调用，并负责唤醒 Lightning。
- `/api/jobs/status` 可以在 PostgreSQL 内执行 stale Worker reconcile，但**绝不访问 Lightning、绝不调用 process-queue、绝不重新唤醒 Worker**。
- Worker Bridge `/api/worker/*` 由 Lightning 主动访问 Vercel，使用短期 Worker Credential，不使用浏览器 Cookie。
- 新增“清除当前历史记录”按钮和 `POST /api/jobs/reset`。
- reset 会清空当前 Job、请求记录、Worker Run，并将 Worker State 恢复为 idle。
- reset 不是部署操作，不会自动执行。
- 已修复 Worker Bridge 被全局 cookie middleware 拦截的问题。
- 已实现 Worker 失联 → Job failed 状态传播：status reconcile 在 stale window 后将仍为 `processing` 的 Job 标记为 `failed`，并将 Worker State 恢复为 `idle`。

## Vercel Build 状态

最近一次 Frontend Preview Deployment 因 TypeScript 类型检查失败：

```text
./app/api/worker/heartbeat/route.ts:41:56
Type error: Object is of type 'unknown'.
```

原因是 postgres tagged-template 查询结果在当前类型定义下为 `unknown[]`，直接访问：

```ts
rows[0].lease_expires_at
```

会在 `next build` 的 type check 阶段失败。

已在 `agent/queue-worker-bridge` 修复为显式结果类型：

```ts
type LeaseRow = { lease_expires_at: Date | string };
const leaseRows = await tx<LeaseRow[]>`...`;
```

修复提交：`1af3e2b6e55b3a6f62eef2e10be59a2ddded8de5`

本次修复只改变 TypeScript 类型声明，不改变 heartbeat 的数据库逻辑、lease 时间或 Worker 行为。

## Worker 真实状态与失联恢复

当前状态源是 Neon 数据库，而不是前端按钮状态：

```text
queued
  ↓
processing
  ├─ complete → completed
  ├─ fail → queued / failed（取决于 attempt_count）
  └─ Worker 失联超过 120 秒 → failed
```

Worker Run：

```text
starting / running
       ↓
正常 finish → completed
       ↓
后端/Lightning 崩溃 → last_seen_at 停止更新
       ↓
超过 120 秒
       ↓
用户手动刷新 /api/jobs/status
       ↓
Worker Run → failed
processing Jobs → failed
photo_worker_state → idle
```

重要：Worker 失联的 Job 不自动重新排队，而是直接标记 `failed`。主动调用 `/api/worker/fail` 的单 Job 错误仍保留原有 `MAX_ATTEMPTS=5` 重试逻辑。

## last_seen_at

以下 Worker Bridge 请求会刷新 `photo_worker_runs.last_seen_at`：

- `POST /api/worker/next`
- `POST /api/worker/heartbeat`
- `POST /api/worker/complete`
- `POST /api/worker/fail`
- `POST /api/worker/finish`

因此长时间 inference 期间由 Lightning heartbeat 保持 Worker Run 活跃；如果整个后端进程崩溃，heartbeat 也会停止，最终进入 stale 状态。

## 状态 API reconcile

`GET /api/jobs/status` 在读取统计信息前会执行一次 stale Worker reconcile：

```text
credential expired OR last_seen_at <= NOW() - 120 seconds
        ↓
processing jobs → failed
worker run → failed
worker state → idle
```

这个 reconcile 只操作 Vercel/Neon 数据，不会向 Lightning 发起任何网络请求，也不会启动新的 Worker。

## 前端状态请求策略

当前代码没有 `setInterval`、`setTimeout` 或其它自动 `/api/jobs/status` 轮询。

请求规则固定为：

- 页面打开：不自动请求。
- 提交任务成功：调用一次 `refreshStatus()`。
- 点击开始处理成功：调用一次 `refreshStatus()`。
- 点击“刷新任务状态”：请求一次。
- Worker 处理过程中：不自动检查。
- Worker 崩溃后：不会自动唤醒，也不会自动请求 status；用户手动刷新后，由 status API 做 stale reconcile。

这与当前设计原则一致：**只有用户明确点击“开始处理”才能产生唤醒 Lightning 的请求；查看状态不能唤醒 Lightning。**

## API 单向访问规则

```text
用户点击“开始处理”
    ↓
/api/jobs/start
    ↓
Lightning /process-queue
```

只有上述路径负责唤醒 Lightning。

```text
用户点击“刷新任务状态”
    ↓
GET /api/jobs/status
    ↓
Neon DB / Queue 状态
```

`/api/jobs/status`：

- 不访问 `LIGHTNING_API_URL`。
- 不调用 `process-queue`。
- 不调用 wake Lightning。
- 不因为 stale Worker 而重新启动 Worker。
- 可以将 stale processing Job 在数据库中标记为 failed。

Lightning → Vercel：

```text
POST /api/worker/next
POST /api/worker/heartbeat
POST /api/worker/complete
POST /api/worker/fail
POST /api/worker/finish
```

## Bridge 认证

`/api/worker/*` 是机器到机器的接口，不使用浏览器登录 Cookie。Next.js middleware 对这些路径放行，由 `lib/worker-auth.ts` 使用短期 Worker Credential 认证。

```text
Authorization: Bearer <short-lived Worker Credential>
        ↓
SHA-256
        ↓
photo_worker_runs.credential_hash
        ↓
expires_at + status 检查
```

普通页面和其它 API 仍使用 `auth_token` Cookie。

## 清除历史记录

新增：

```text
POST /api/jobs/reset
```

执行：

```sql
TRUNCATE TABLE photo_jobs, photo_requests, photo_worker_runs RESTART IDENTITY CASCADE;
```

并将：

```text
photo_worker_state.status = idle
photo_worker_state.active_run_id = NULL
```

这是开发/调试阶段的全局管理功能，正式生产环境需要增加管理员权限或用户隔离。

## 数据库 Migration

Vercel build 已自动执行：

```text
npm run db:migrate
↓
next build
```

当前 heartbeat 类型修复不需要新的 migration，因为只涉及 TypeScript 类型，不改变数据库 schema。

## 当前分支

Frontend：`agent/queue-worker-bridge`

Backend：`agent/queue-worker-bridge`

## 下一步

1. 等待本次 `1af3e2b6e55b3a6f62eef2e10be59a2ddded8de5` 自动触发的 Vercel Preview Build。
2. 确认 TypeScript type check 通过。
3. 重新检查 `/api/jobs/status` 不存在任何 Lightning 网络调用。
4. 关闭旧 Preview 标签页并打开最新 Preview。
5. 点击“清除当前历史记录”，确认回到 idle/0 jobs。
6. 提交 1 个任务并手动刷新确认 queued。
7. 点击开始处理，确认只有 `/api/jobs/start` 唤醒 Lightning。
8. Lightning 日志确认请求 URL：`https://<preview-host>/api/worker/next`。
9. 确认 R2 → inference → complete → finish 正常。
10. 故意停止 Lightning 后端，等待超过 120 秒。
11. 手动点击“刷新任务状态”，确认 processing Job 变为 failed，Worker 状态回到 idle，并确认没有新的 Lightning 唤醒请求。
12. 再测试正常 3 Job 串行、heartbeat、lease recovery、重复 complete、fail/retry。
