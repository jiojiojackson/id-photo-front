# AI 证件照生产架构开发计划

## 1. 目标架构

```text
用户
 ↓
Vercel
 ├─ 提交任务 → R2 原图 + Neon Job + Queue
 │              （不启动 Lightning）
 │
 └─ 点击开始处理
      ├─ 原子创建 worker_run
      ├─ 创建短期 Worker Credential
      └─ 生产：LIGHTNING_API_URL + LIGHTNING_API_KEY
         调试：直接 POST Lightning Studio FastAPI /process-queue
              ↓
       Lightning Worker
       ├─ 模型加载一次
       ├─ POST /api/worker/next
       ├─ claim + lease
       ├─ R2 input GET / output PUT
       ├─ complete / fail
       ├─ heartbeat
       └─ empty → finish
```

核心原则：Vercel 负责任务协调，Lightning 负责 GPU 推理；模型生命周期绑定 Worker Run，而不是单个 Job。

## 2. 环境变量

### Vercel Production

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

### Vercel Debug

```text
DEBUG_DIRECT_BACKEND=true
LIGHTNING_API_URL=https://<Lightning-Studio-public-url>
```

Debug 模式不需要 `LIGHTNING_API_KEY`。

但 `worker_credential` 仍然必须传给 Lightning，因为它用于：

```text
Lightning Worker → Vercel Bridge
```

Lightning 应用本身不读取项目级 `LIGHTNING_*`、Database、R2、Queue 环境变量。

## 3. 提交任务

提交阶段：

1. 原图上传到 R2。
2. 创建 `photo_request`。
3. 创建多个 `photo_jobs`。
4. 发布 Queue message。
5. 不启动 Lightning。
6. 不生成 processing presigned URL。

## 4. 开始处理

点击开始后：

1. 行锁检查 `photo_worker_state`。
2. 恢复 stale / expired Worker Run。
3. 创建 `photo_worker_runs`。
4. 生成短期 Worker Credential，只保存 hash。
5. 生产模式使用 Lightning API Key 唤醒平台。
6. Debug 模式直接 POST Lightning Studio `/process-queue`。
7. 请求 body 包含：

```json
{
  "worker_run_id": "...",
  "bridge_url": "https://当前Vercel部署/api/worker",
  "vercel_origin": "https://当前Vercel部署",
  "worker_credential": "...",
  "worker_credential_expires_at": "..."
}
```

## 5. 动态 Vercel Preview Hostname

**禁止硬编码 `id-photo-front.vercel.app`。** Preview hostname 每次部署都可能不同。

Vercel `/api/jobs/start` 使用当前实际请求的：

```ts
const vercelOrigin = request.nextUrl.origin;
```

因此如果用户当前访问的是：

```text
https://id-photo-front-git-feature-xxx.vercel.app
```

则 Worker Bridge 使用这个实际 hostname，而不是 Production hostname。

Lightning 后端 `/process-queue`：

1. 读取 `vercel_origin`。
2. 验证 scheme + hostname。
3. 重新构造：

```text
https://<current-preview-host>/api/worker
```

4. 所有 Bridge 请求都从这个 origin 构造。

同时记录：

```text
[QueueWorker] /process-queue received run=...
vercel_origin=https://...
bridge_url=https://.../api/worker
```

Lightning 自己收到的 HTTP `Host` 会单独记录，但它不是 Vercel hostname。Vercel hostname 必须来自 wake payload 的 `vercel_origin`。

## 6. Queue Bridge

```text
POST /api/worker/next
POST /api/worker/heartbeat
POST /api/worker/complete
POST /api/worker/fail
POST /api/worker/finish
```

所有 Bridge API 使用短期 Worker Credential。

`next` 使用 Neon transaction + `FOR UPDATE SKIP LOCKED` claim Job，并设置 lease。

Claim 成功后才生成 R2 input/output presigned URL。

当前：

```text
lease = 10 分钟
heartbeat = 60 秒
presigned URL = 15 分钟
MAX_ATTEMPTS = 5
```

正式生产前根据真实推理时间重新校准。

## 7. Queue ACK

Queue message 在 Bridge 成功 claim 后即可 ACK；Neon Job lease 才是任务所有权 source of truth。

```text
Queue message
 ↓
Bridge claim
 ↓
ACK
 ↓
Lightning inference
 ↓
complete / fail
```

Worker 崩溃后 lease 到期，下一次 Worker Run 可重新 claim。

## 8. Lightning Worker

一个 Worker Run：

1. 复用已初始化的 `IDCreator`。
2. `next` 获取 Job。
3. 下载 R2 input。
4. GPU inference。
5. 上传 R2 output。
6. complete。
7. heartbeat 每 60 秒。
8. 失败调用 fail 后继续下一个 Job。
9. empty 后 finish。

GPU inference 串行，不为每个 Job 重载模型。

## 9. 前端状态请求策略

旧方案每 2.5 秒自动请求：

```text
GET /api/jobs/status
```

这会在 Lightning 推理期间持续消耗 Vercel/Neon/R2 资源，现已删除。

新方案：

### 自动请求的必要场景

- 提交任务成功后刷新一次。
- 点击开始处理成功/失败后刷新一次。

### 用户主动请求

UI 提供：

```text
刷新任务状态
```

用户需要查看 Worker 当前进度、结果时点击一次。

### 禁止

- 禁止 `setInterval`。
- 禁止页面打开后自动持续轮询。
- 禁止后台每 2.5 秒查询状态。

这意味着 Lightning inference 期间，前端默认不产生 `/api/jobs/status` 流量。

## 10. 当前数据库重置

为解决当前旧数据导致的：

```text
处理中 0 个
```

以及 Worker State 卡住的问题，新增：

```text
scripts/reset-db.mjs
npm run db:reset
```

会事务性执行：

```sql
TRUNCATE TABLE photo_jobs, photo_requests, photo_worker_runs RESTART IDENTITY CASCADE;
```

然后重置：

```text
photo_worker_state.status = idle
photo_worker_state.active_run_id = NULL
```

**绝对不能加入 `vercel-build`。** 这是一次性人工调试命令。

当前连接没有直接执行 Neon SQL 的能力，因此代码已提交，但没有伪造声称数据库已经被清空。部署后使用当前 Vercel `DATABASE_URL` 执行一次即可。

## 11. Migration

生产数据库结构由：

```text
db/migrations/*.sql
```

管理。

Vercel build：

```text
npm run db:migrate
↓
next build
```

新的 schema 必须新增 migration，不能把 reset 操作加入 migration。

## 12. 当前开发状态

### 已完成

- Neon Job 模型。
- Vercel Queue publishing/polling。
- R2 SigV4 原图上传。
- 提交/开始分离。
- Worker Run。
- Worker Credential。
- Job claim + lease。
- heartbeat / complete / fail / finish。
- Worker 崩溃恢复。
- Migration 自动化。
- Lightning Studio 直接 FastAPI Debug 模式。
- `/process-queue` 自动追加路径。
- Preview hostname 动态传递到 Lightning。
- Lightning 后端使用 wake payload 的 `vercel_origin` 构造 Bridge 主机地址。
- 前端取消 `/api/jobs/status` 自动轮询，改为手动刷新。
- 添加一次性 `npm run db:reset` 调试命令。

### 下一步

1. 部署最新 Frontend Preview。
2. 清空当前 Neon 调试数据后回到初始状态。
3. 确认页面不会自动请求 `/api/jobs/status`。
4. 提交 1 个任务，手动刷新确认 queued。
5. 点击开始处理。
6. Lightning 日志确认真实 Preview `vercel_origin`。
7. 确认 Worker 请求：

```text
POST https://<当前-preview-host>/api/worker/next
```

8. 如果不再 401，继续调试 R2 → inference → complete → finish。
9. 完成 1 Job 后测试 3 Job 串行。
10. 测试 heartbeat、lease recovery、重复 complete、fail/retry。
11. 最后切回 Lightning Platform Wake 模式。
