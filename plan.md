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

新方案已经删除自动轮询。

### 当前请求规则

- 页面打开：不请求。
- 提交任务成功：刷新一次。
- 开始处理成功/失败：刷新一次。
- 用户点击“刷新任务状态”：请求一次。
- Lightning 推理期间：默认不请求。

### 关于旧 Preview / 历史部署

Vercel 历史 Deployment 本身不会在服务器后台自动执行浏览器里的 `setInterval`。原来的轮询代码运行在**访问该 Deployment 的浏览器页面**中。

因此：

- 如果旧 Preview 页面仍开着，它可能继续轮询。
- 关闭旧标签页、刷新到最新 Preview，旧 JS 就停止。
- 已经关闭的页面不会继续产生轮询。
- 新版本不会产生轮询。

如果需要强制阻止旧 Deployment 的访问，可以在 Vercel Dashboard 删除旧 Preview Deployment；但通常没有必要，关闭旧页面即可。

## 10. 手动清除历史记录

新增 API：

```text
POST /api/jobs/reset
```

前端新增按钮：

```text
清除当前历史记录
```

点击后弹出确认：

```text
确定清除当前所有任务和历史记录吗？
这会删除当前 Job、请求记录和 Worker Run，无法恢复。
如果 Lightning 正在处理任务，请先确认它已经停止。
```

确认后由 Vercel API 在一个数据库 transaction 内执行：

```sql
TRUNCATE TABLE photo_jobs, photo_requests, photo_worker_runs RESTART IDENTITY CASCADE;
```

并恢复：

```text
photo_worker_state.status = idle
photo_worker_state.active_run_id = NULL
```

清除成功后前端直接将当前 UI 恢复为：

```text
queued = 0
processing = 0
completed = 0
failed = 0
jobs = []
worker = idle
```

### 安全注意

当前属于开发/调试阶段，reset API 是全局清除功能。正式生产环境必须增加管理员权限或用户隔离，不能允许普通用户删除整个系统的任务历史。

## 11. CLI 数据库重置

仍保留：

```bash
npm run db:reset
```

用于没有前端访问权限时的调试恢复。

**绝对不能加入 `vercel-build`。**

## 12. Migration

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

## 13. 当前开发状态

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
- 添加 CLI `npm run db:reset`。
- 添加前端“清除当前历史记录”与 `POST /api/jobs/reset`。

### 下一步

1. 部署最新 Frontend Preview。
2. 关闭旧 Preview 标签页，确保旧 JS 不再运行。
3. 点击“清除当前历史记录”，确认数据库回到 idle/0 jobs。
4. 提交 1 个任务，手动刷新确认 queued。
5. 点击开始处理。
6. Lightning 日志确认真实 Preview `vercel_origin`。
7. 确认 Worker 请求：

```text
POST https://<当前-preview-host>/api/worker/next
```

8. 如果不再 401，继续 R2 → inference → complete → finish。
9. 完成 1 Job 后测试 3 Job 串行。
10. 测试 heartbeat、lease recovery、重复 complete、fail/retry。
11. 最后切回 Lightning Platform Wake 模式。
