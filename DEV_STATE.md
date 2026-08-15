# DEV_STATE

当前开发分支：`agent/queue-worker-bridge`

本项目是 Vercel + Neon + R2 + Vercel Queue + Lightning 的异步证件照前端。提交任务与开始处理分离：提交只创建 Job/Queue；点击开始才创建 Worker Run、短期 Worker Credential 并唤醒 Lightning。

## 当前状态

- `/api/jobs/status` 已取消自动轮询；前端只在必要动作后或用户手动点击时请求。
- 新增“清除当前历史记录”按钮和 `POST /api/jobs/reset`。
- reset 会清空当前 Job、请求记录、Worker Run，并将 Worker State 恢复为 idle。
- reset 不是部署操作，不会自动执行。

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
- 数据库 migration 自动化：Vercel build 先执行 `npm run db:migrate`。
- Lightning Studio 直接 FastAPI 调试模式，不使用 Docker，不使用 Lightning Platform API Key。
- `LIGHTNING_API_URL` 自动规范化为 `/process-queue`。
- Preview hostname 动态传递到 Lightning。

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
2. 关闭旧 Preview 标签页并重新打开最新 Preview，避免旧 JS 继续请求 `/api/jobs/status`。
3. 点击“清除当前历史记录”，确认回到 idle/0 jobs。
4. 提交 1 个任务并手动刷新确认 queued。
5. 点击开始处理。
6. Lightning 日志确认真实 Preview `vercel_origin`。
7. 验证 Worker → `/api/worker/next`。
8. 认证通过后继续 R2 → inference → complete → finish。
