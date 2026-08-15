# DEV_STATE

当前开发分支：`agent/queue-worker-bridge`

本项目是 Vercel + Neon + R2 + Vercel Queue + Lightning 的异步证件照前端。提交任务与开始处理分离：提交只创建 Job/Queue；点击开始才创建 Worker Run、短期 Worker Credential 并唤醒 Lightning。

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

## 2026-08-15 联合调试状态

### Wake URL

此前 `LIGHTNING_API_URL` 指向 `/`，导致：

```text
POST / 405 Method Not Allowed
```

现已修复为：

```text
POST ${LIGHTNING_API_URL}/process-queue
```

Lightning 已确认：

```text
POST /process-queue 200 OK
```

### 当前调试模式

Vercel Preview：

```text
DEBUG_DIRECT_BACKEND=true
LIGHTNING_API_URL=https://<Lightning-Studio-public-url>
```

调试时不需要 `LIGHTNING_API_KEY`。但 `worker_credential` 仍必须从 Vercel 传给 Lightning，因为它用于 Lightning → Vercel Bridge 的 Bearer Authentication。

## 2026-08-15 新调试方案

### 1. 前端不再循环轮询 `/api/jobs/status`

旧实现每 2.5 秒自动请求一次：

```text
GET /api/jobs/status
```

这会持续消耗 Vercel Function/Neon/R2 资源，尤其是 Lightning 推理期间用户不操作页面时没有必要。

现在改为 **手动刷新 + 必要时请求**：

- 页面打开不自动请求状态。
- 用户点击“刷新任务状态”时请求一次。
- 提交任务成功后自动刷新一次。
- 点击“开始处理”成功/失败后刷新一次。
- 不再使用 `setInterval`。
- 处理过程中如果需要查看最新状态，用户手动点击刷新。

UI 新增：

```text
刷新任务状态
```

因此 `/api/jobs/status` 不再持续循环请求。

### 2. Vercel Preview hostname 改为动态传递

不能硬编码：

```text
https://id-photo-front.vercel.app
```

因为 Preview Deployment 的 hostname 每次可能不同。

`/api/jobs/start` 现在使用当前实际请求：

```ts
const vercelOrigin = request.nextUrl.origin;
const bridgeUrl = `${vercelOrigin}/api/worker`;
```

并向 Lightning `/process-queue` 明确发送：

```json
{
  "bridge_url": "https://当前Preview域名/api/worker",
  "vercel_origin": "https://当前Preview域名"
}
```

后端收到 `/process-queue` 后，以 `vercel_origin` 为权威来源重新构造：

```text
https://当前Preview域名/api/worker/next
https://当前Preview域名/api/worker/heartbeat
https://当前Preview域名/api/worker/complete
https://当前Preview域名/api/worker/fail
https://当前Preview域名/api/worker/finish
```

后端同时打印：

```text
[QueueWorker] /process-queue received run=...
vercel_origin=https://xxx.vercel.app
bridge_url=https://xxx.vercel.app/api/worker
```

并打印 Lightning 自己收到的 HTTP host：

```text
[QueueWorker] /process-queue inbound host=...
forwarded_host=...
```

注意：Lightning 收到的 HTTP `Host` 是 Lightning 自己的主机地址，不是 Vercel。真正的 Vercel Preview hostname 必须由 Vercel 在 wake payload 中显式传递，因此 `vercel_origin` 是本次动态 Preview hostname 的权威来源。

### 3. 当前数据库状态重置

当前已有旧 Job/Worker 状态导致前端显示“处理中 0 个”并阻止再次开始。

新增：

```text
scripts/reset-db.mjs
```

以及：

```json
"db:reset": "node scripts/reset-db.mjs"
```

执行会事务性清除：

- `photo_jobs`
- `photo_requests`
- `photo_worker_runs`

并将：

```text
photo_worker_state → idle
active_run_id → NULL
```

由于当前工具连接没有直接执行 Neon SQL 的权限，我没有伪造“已经清除数据库”的结果；代码已准备好，部署后可使用 Vercel 环境中的 `DATABASE_URL` 执行一次 `npm run db:reset`。

**不要把 `db:reset` 放进 `vercel-build`。** 它只能人工执行一次，不能随部署自动执行，否则每次 Preview/Production 部署都会删除任务。

## 当前分支与最新改动

Frontend：

```text
agent/queue-worker-bridge
```

主要最新 commits：

```text
8e6099d1  manual status refresh
5abe6d2c  dynamic Vercel origin in wake payload
7b414e5f  add db:reset script
```

Backend：

```text
agent/queue-worker-bridge
```

最新动态 hostname 后端 commit：

```text
cd441ccc9aea74eb5bbd4c8cc3420f0508c34eec
```

## 后端启动

Lightning Studio Linux：

```bash
cd /path/to/id-photo-back
python3 -m uvicorn api_server:app --host 0.0.0.0 --port 8000
```

## 下一步

1. 部署当前 Frontend Preview。
2. 用当前 Preview URL 测试 `/api/jobs/start`。
3. Lightning 日志必须显示实际的 `vercel_origin`，不能再出现固定的 `id-photo-front.vercel.app`。
4. 验证 `POST <preview-host>/api/worker/next`。
5. 解决 Worker Credential 401（如果仍存在）。
6. 认证通过后继续验证 R2 → inference → complete → finish。
7. 完成 1 Job，再测试 3 Job 串行。
8. 最终再切回生产 Lightning Platform Wake。
