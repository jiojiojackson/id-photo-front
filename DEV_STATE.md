# DEV_STATE

当前开发分支：`agent/queue-worker-bridge`

本项目是 Vercel + Neon + R2 + Vercel Queue + Lightning 的异步证件照前端。提交任务与开始处理分离：提交只创建 Job/Queue；点击开始才创建 Worker Run、短期 Worker Credential 并唤醒 Lightning。

## 当前状态

- `/api/jobs/status` 已取消自动轮询；前端只在必要动作后或用户手动点击时请求。
- 新增“清除当前历史记录”按钮和 `POST /api/jobs/reset`。
- reset 会清空当前 Job、请求记录、Worker Run，并将 Worker State 恢复为 idle。
- reset 不是部署操作，不会自动执行。
- **已修复 Worker Bridge 被全局 cookie middleware 拦截的问题。** `/api/worker/*` 现在绕过浏览器 `auth_token` middleware，改由短期 Worker Credential 在 `lib/worker-auth.ts` 中独立认证。
- **新增 Worker 失联 → Job failed 状态传播。** Lightning/后端进程停止后，`last_seen_at` 不再更新；状态请求在 120 秒 stale window 后会把该 Worker Run 下仍为 `processing` 的 Job 置为 `failed`，并把 Worker State 恢复为 `idle`。
- 前端保持“不做持续轮询”的原则，但点击开始后会安排一次约 130 秒后的必要状态检查，用于在后端崩溃后自动把 UI 从“处理中”更新为“失败”。用户也可以随时手动刷新。

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
status API / start API reconcile
       ↓
Worker Run → failed
processing Jobs → failed
photo_worker_state → idle
```

重要：对于本调试阶段，Worker 失联的 Job 不自动重新排队，而是直接标记 `failed`，符合“后端崩溃时前端显示处理失败”的要求。主动调用 `/api/worker/fail` 的单 Job 错误仍保留原有 `MAX_ATTEMPTS=5` 重试逻辑。

### last_seen_at

以下 Worker Bridge 请求会刷新 `photo_worker_runs.last_seen_at`：

- `POST /api/worker/next`
- `POST /api/worker/heartbeat`
- `POST /api/worker/complete`
- `POST /api/worker/fail`
- `POST /api/worker/finish`

因此长时间 inference 期间由 Lightning heartbeat 保持 Worker Run 活跃；如果整个后端进程崩溃，heartbeat 也会停止，最终进入 stale 状态。

### 状态 API reconcile

`GET /api/jobs/status` 在读取统计信息前会执行一次 stale Worker reconcile：

```text
credential expired OR last_seen_at <= NOW() - 120 seconds
        ↓
processing jobs → failed
worker run → failed
worker state → idle
```

这不是后台任务，也不会创建新的轮询。

## 最近一次认证问题定位

Lightning 已经能够访问 Preview Deployment，Vercel Deployment Protection 已关闭后，返回从：

```text
401 Protected deployment
```

变成：

```text
401 {"error":"Unauthorized"}
```

进一步检查发现 `middleware.ts` 对所有 `/api/*` 默认要求浏览器 `auth_token` Cookie，而 Lightning 是机器客户端，不可能携带该 Cookie。因此请求在 Next.js Route Handler 之前就被 middleware 返回 401，`/api/worker/next` 的 `authenticateWorker()` 实际上没有机会执行。

修复：

```text
/api/worker/*
    ↓
跳过 auth_token middleware
    ↓
/api/worker/* Route Handler
    ↓
Bearer <short-lived Worker Credential>
    ↓
lib/worker-auth.ts
```

普通页面和其它 API 仍然使用原来的 `auth_token` Cookie 保护。

这次修改没有削弱 Worker Bridge 的认证：Worker Bridge 不是匿名开放，而是把认证责任从浏览器 Cookie middleware 转移到专门的短期 Worker Credential。

## 已完成

- Next.js + Neon/Postgres Job 数据模型。
- Vercel Queue publishing + PollingQueueClient。
- R2 SigV4 server-side PUT 原图上传。
- processing R2 presigned GET/PUT URL 延迟到 Worker `next` claim 后生成。
- `photo_worker_runs` + `photo_worker_state`。
- 开始处理的数据库原子并发保护。
- 短期 Worker Credential，默认有效 4 小时，仅保存 hash。
- Vercel Queue Bridge：`next` / `heartbeat` / `complete` / `fail` / `finish`。
- Job claim + lease + attempt recovery。
- complete/fail 的 Worker/lease 条件保护及 complete 幂等。
- Worker `last_seen_at` heartbeat 生命周期。
- Worker stale reconcile：后端失联时 processing Job 进入 failed，Worker State 回到 idle。
- 数据库 migration 自动化：Vercel build 先执行 `npm run db:migrate`。
- Lightning Studio 直接 FastAPI 调试模式，不使用 Docker，不使用 Lightning Platform API Key。
- `LIGHTNING_API_URL` 自动规范化为 `/process-queue`。
- Preview hostname 动态传递到 Lightning。
- 修复 Lightning Bridge URL 从 `/api/worker/api/worker/next` 重复拼接为正确的 `/api/worker/next`。
- 区分 Vercel Deployment Protection 401 与 Worker Credential 401。
- 修复 `middleware.ts` 对 `/api/worker/*` 的错误 cookie 鉴权拦截。
- 前端失败状态展示：失败数量和每个 Job 的失败错误信息。
- 前端在开始处理后安排一次 stale 状态检查，不恢复高频 `/api/jobs/status` 轮询。

## 状态请求策略

旧版本每 2.5 秒自动请求：

```text
GET /api/jobs/status
```

当前代码已移除 `setInterval`。一个**已经打开的旧网页/旧 Preview 页面**如果仍在浏览器中运行旧 JavaScript，它仍可能继续请求，直到该页面刷新/关闭或旧页面脚本停止；删除/更新 Vercel Deployment 本身不会强制停止已经在用户浏览器中运行的 JS。

当前版本：

- 页面打开不自动轮询。
- 提交成功后刷新一次。
- 开始处理后刷新一次。
- 用户点击“刷新任务状态”时请求一次。
- 开始处理后额外安排一次约 130 秒后的状态检查，用于检测 Worker 崩溃/失联；不是循环。

因此新版本不会产生后台循环 `/api/jobs/status`。

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

前端新增：

```text
清除当前历史记录
```

点击后必须确认一次，并提示：

> 这会删除当前 Job、请求记录和 Worker Run，无法恢复。如果 Lightning 正在处理任务，请先确认它已经停止。

清除成功后，前端立即把任务数量、Worker 状态和结果列表恢复到初始状态，不再额外轮询。

### 重要

这个按钮是开发/调试阶段的管理功能。正式生产环境建议增加管理员权限或仅在开发模式开放，否则普通用户可以清空共享数据库中的所有任务。

## Vercel Preview hostname

禁止硬编码：

```text
https://id-photo-front.vercel.app
```

`/api/jobs/start` 使用：

```ts
const vercelOrigin = request.nextUrl.origin;
```

并发送 `vercel_origin` 给 Lightning。后端以它构造 Bridge URL。

## 数据库脚本

仍保留一次性 CLI：

```bash
npm run db:reset
```

但现在前端也提供 reset API，因此部署后可以直接通过 UI 清除当前历史记录。

**不要把 reset 放入 `vercel-build`。**

## 当前分支

Frontend：`agent/queue-worker-bridge`

Backend：`agent/queue-worker-bridge`

## 下一步

1. 部署最新 Frontend Preview。
2. 关闭旧 Preview 标签页并重新打开最新 Preview。
3. 点击“清除当前历史记录”，确认回到 idle/0 jobs。
4. 提交 1 个任务并手动刷新确认 queued。
5. 点击开始处理。
6. Lightning 日志确认请求 URL：`https://<preview-host>/api/worker/next`。
7. 确认这次不再出现 Vercel Protection 401，也不再被 middleware 返回 `{"error":"Unauthorized"}`。
8. 观察 `/api/worker/next` 是否返回 200，并确认出现 Job claim。
9. 继续验证 R2 → inference → complete → finish。
10. **故意停止 Lightning 后端进程**，等待超过 120 秒，再观察前端一次性状态检查是否显示“✕ 失败”，以及错误信息是否为 Worker 失联。
11. 手动点击“刷新任务状态”，确认相同结果，并确认 Worker 状态恢复 idle。
12. 再测试正常 3 Job 串行、heartbeat、lease recovery、重复 complete、fail/retry。
