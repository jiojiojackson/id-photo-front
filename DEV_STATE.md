# DEV_STATE

当前开发分支：`agent/queue-worker-bridge`

本项目正式前端架构为 Vercel + Neon + R2 + Vercel Queue + Lightning。后端 `id-photo-back` 已调试完成，本阶段不修改后端。

## 当前 Production 状态

前端已经从 Debug/开发模式收敛为正式 Lightning Platform 调用模式。

- 已删除 `DEBUG_DIRECT_BACKEND` 代码逻辑。
- `/api/jobs/start` 必须同时配置 `LIGHTNING_API_URL` 和 `LIGHTNING_API_KEY`。
- 唤醒 Lightning 时固定使用 `Authorization: Bearer <LIGHTNING_API_KEY>`。
- Worker Credential 仍由 Vercel 在开始处理时生成，短期有效，只保存 hash 到 Neon，并通过 wake payload 传给 Lightning。
- `bridge_url` / `vercel_origin` 使用当前 Vercel 请求 origin 动态生成，不硬编码域名。
- `/api/jobs/status` 仍然只访问 Neon/Queue，不访问 Lightning、不调用 `/process-queue`、不重新唤醒 Worker。
- 前端没有自动 status polling；只有提交成功、开始成功或用户手动点击刷新时请求状态。
- `id-photo-back` 保持当前已调试版本，不需要修改。

## Production 环境变量

Vercel Production 应配置：

```text
DATABASE_URL
R2_ACCOUNT_ID
R2_ACCESS_KEY_ID
R2_SECRET_ACCESS_KEY
R2_BUCKET_NAME
VERCEL_QUEUE_NAME
VERCEL_QUEUE_REGION
VERCEL_QUEUE_CONSUMER_GROUP
LIGHTNING_API_URL
LIGHTNING_API_KEY
```

`DEBUG_DIRECT_BACKEND` 已从代码删除。Vercel Project Settings 中如果仍存在该旧变量，可以删除；代码不会再读取它。

Lightning 本身不需要项目级 Database、R2、Queue 环境变量。Vercel → Lightning 使用 `LIGHTNING_API_KEY` 做平台认证；Lightning → Vercel Bridge 使用 wake payload 中的短期 Worker Credential。

## 正式版 Lightning 调用链

```text
用户点击“开始处理”
        ↓
POST /api/jobs/start
        ↓
Neon 创建 worker_run
        ↓
生成短期 Worker Credential
        ↓
POST LIGHTNING_API_URL/process-queue
Authorization: Bearer LIGHTNING_API_KEY
        ↓
Lightning Worker
        ↓
POST /api/worker/next
POST /api/worker/heartbeat
POST /api/worker/complete
POST /api/worker/fail
POST /api/worker/finish
```

`/api/jobs/start` 是唯一允许产生 Vercel → Lightning 唤醒请求的入口。

## 状态与 Worker 失联

Worker Bridge 会通过 `next`、`heartbeat`、`complete`、`fail`、`finish` 更新 `photo_worker_runs.last_seen_at`。

如果 Lightning/Worker 整体崩溃，heartbeat 停止。超过 120 秒后，用户手动刷新 `/api/jobs/status` 时执行 stale reconcile：

```text
processing Job
      ↓
Worker Run stale / credential expired
      ↓
Job → failed
Worker Run → failed
photo_worker_state → idle
```

失联 Job 不自动重新排队，也不会因为 status reconcile 自动重新唤醒 Lightning。单个 Job 主动调用 `/api/worker/fail` 时仍保留原有 `MAX_ATTEMPTS=5` 重试逻辑。

## 前端状态请求规则

- 页面打开：不自动请求 status。
- 提交任务成功：刷新一次。
- 开始处理成功：刷新一次。
- 用户点击“刷新任务状态”：请求一次。
- 处理过程中：不自动请求。
- Worker 崩溃后：不自动请求、不自动唤醒。
- 用户手动刷新后：status API 在 Neon 内执行 stale reconcile，并返回真实 `failed` 状态。

核心原则：**查看状态和唤醒 Lightning 完全解耦。**

## API 单向访问边界

```text
用户点击开始
    ↓
/api/jobs/start
    ↓
Lightning /process-queue
```

```text
用户点击刷新
    ↓
/api/jobs/status
    ↓
Neon / Queue
```

`/api/jobs/status` 禁止：

- 访问 `LIGHTNING_API_URL`
- 调用 `/process-queue`
- 调用 wake Lightning
- 因 stale 自动创建 Worker Run

Lightning → Vercel Bridge 允许：

```text
/api/worker/next
/api/worker/heartbeat
/api/worker/complete
/api/worker/fail
/api/worker/finish
```

这些接口使用短期 Worker Credential，不使用浏览器 Cookie。

## Vercel Build 修复

此前 `app/api/worker/heartbeat/route.ts` 因 postgres 查询结果在 TypeScript 中被推断为 `unknown[]`，导致 Vercel build 在 type check 阶段失败：

```text
Type error: Object is of type 'unknown'.
```

已通过显式 `LeaseRow` 类型修复：

```ts
type LeaseRow = { lease_expires_at: Date | string };
const leaseRows = await tx<LeaseRow[]>`...`;
```

该修复只解决类型检查，不改变 heartbeat、lease 或数据库业务逻辑，也不需要 migration。

修复提交：`1af3e2b6e55b3a6f62eef2e10be59a2ddded8de5`

## Production 收敛

正式版提交：`da10e349af270e7e5546d4a82bd7ff9b64d30dc3`

本提交：

1. 删除 `DEBUG_DIRECT_BACKEND`。
2. 强制 `LIGHTNING_API_KEY`。
3. Lightning wake 请求固定携带 Bearer API Key。
4. 保留 Worker Credential、Bridge、动态 Vercel origin 和 stale reconcile。
5. 不修改后端仓库。

## Migration

Vercel build 自动执行：

```text
npm run db:migrate
↓
next build
```

本次 Production 收敛没有数据库 schema 变化，不需要新的 migration。

## 当前分支

Frontend：`agent/queue-worker-bridge`

Backend：`agent/queue-worker-bridge`（本阶段未修改）

## Production 验证清单

1. Vercel Production 配置 `LIGHTNING_API_URL` 与 `LIGHTNING_API_KEY`。
2. 删除 Vercel Project Settings 中遗留的 `DEBUG_DIRECT_BACKEND`（如果存在）。
3. 确认 Production Build 通过。
4. 提交任务，确认不会唤醒 Lightning。
5. 点击开始处理，确认 `/api/jobs/start` 唤醒 Lightning，并发送 Bearer API Key。
6. 确认 Lightning → Bridge → R2 → inference → complete → finish 正常。
7. 手动刷新状态，确认不会产生 Lightning 请求。
8. 停止 Lightning Worker，等待超过 120 秒后手动刷新，确认 Job → failed、Worker State → idle，且不会自动重新唤醒 Lightning。
9. 最后进行多 Job、heartbeat、lease recovery、重复 complete、fail/retry 的回归测试。
