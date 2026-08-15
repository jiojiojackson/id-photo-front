# AI 证件照生产架构开发计划

## 1. 目标架构

```text
用户
 ↓
Vercel
 ├─ 提交任务 → R2 原图 + Neon Job + Queue
 │              （不启动 Lightning）
 │
 └─ 用户点击开始处理
      ├─ 原子创建 worker_run
      ├─ 创建短期 Worker Credential
      └─ 唤醒 Lightning
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

核心原则：Vercel 负责任务协调，Lightning 负责推理；模型生命周期绑定 Worker Run，而不是单个 Job。

## 2. API 访问边界

### 唤醒 Lightning

只有：

```text
用户点击“开始处理”
    ↓
POST /api/jobs/start
    ↓
Lightning /process-queue
```

才允许产生 Vercel → Lightning 的唤醒请求。

### 查看状态

```text
用户点击“刷新任务状态”
    ↓
GET /api/jobs/status
    ↓
Neon / Queue 状态
```

`/api/jobs/status` 可以执行 stale Worker reconcile，但必须满足：

- 不访问 `LIGHTNING_API_URL`。
- 不调用 `/process-queue`。
- 不唤醒 Lightning。
- 不因为 stale Worker 自动创建新的 Worker Run。
- 可以在 PostgreSQL 中将 stale processing Job 标记为 `failed`。

### Lightning → Vercel Bridge

```text
POST /api/worker/next
POST /api/worker/heartbeat
POST /api/worker/complete
POST /api/worker/fail
POST /api/worker/finish
```

这些接口由 Lightning Worker 主动调用，使用短期 Worker Credential，不使用浏览器 Cookie。

## 3. 环境变量

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

Lightning 应用本身不读取项目级 `LIGHTNING_*`、Database、R2、Queue 环境变量。Worker Credential 通过 wake payload 传递给 Lightning，用于 Lightning → Vercel Bridge 认证。

## 4. 提交任务

提交阶段：

1. 原图上传到 R2。
2. 创建 `photo_request`。
3. 创建多个 `photo_jobs`。
4. 发布 Queue message。
5. 不启动 Lightning。
6. 不生成 processing presigned URL。

## 5. 开始处理

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

如果已有 Worker Run 超过 120 秒没有 `last_seen_at` 更新，则开始新的 Worker Run 前会先把该旧 Run 以及它仍处于 `processing` 的 Job 标记为 `failed`，再恢复 Worker State 为 `idle`。

## 6. 动态 Vercel Preview Hostname

**禁止硬编码 `id-photo-front.vercel.app`。** Preview hostname 每次部署都可能不同。

Vercel `/api/jobs/start` 使用当前实际请求的：

```ts
const vercelOrigin = request.nextUrl.origin;
```

并发送 `vercel_origin` 给 Lightning。后端以它构造 Bridge URL。

Lightning 后端 `/process-queue`：

1. 读取 `vercel_origin`。
2. 验证 scheme + hostname。
3. 重新构造：

```text
https://<current-preview-host>/api/worker
```

4. 所有 Bridge 请求都从这个 origin 构造。

## 7. Queue Bridge

所有 Bridge API 使用短期 Worker Credential。

`next` 使用 Neon transaction + `FOR UPDATE SKIP LOCKED` claim Job，并设置 lease。

Claim 成功后才生成 R2 input/output presigned URL。

当前：

```text
lease = 10 分钟
heartbeat = 60 秒
presigned URL = 15 分钟
MAX_ATTEMPTS = 5
Worker stale = 120 秒
```

正式生产前根据真实推理时间重新校准。

### Worker Run liveness

`photo_worker_runs.last_seen_at` 会在以下 Bridge 请求中刷新：

```text
next
heartbeat
complete
fail
finish
```

heartbeat 是长时间 inference 的 liveness 信号。后端进程崩溃时 heartbeat 停止，`last_seen_at` 最终过期。

### Worker 失联后的真实状态

用户下一次手动请求 `/api/jobs/status` 时执行轻量 reconcile：

```text
active Worker Run
      ↓
credential expired OR last_seen_at <= 120s 未更新
      ↓
processing Jobs → failed
Worker Run → failed
Worker State → idle
```

本阶段设计：**Worker 整体崩溃/失联直接显示失败，不自动重新排队，也不自动重新唤醒 Lightning。**

单个 Job 主动调用 `/api/worker/fail` 时仍保留 `MAX_ATTEMPTS=5` 重试策略。

## 8. Queue ACK

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

## 9. Lightning Worker

一个 Worker Run：

1. 复用已初始化的 `IDCreator`。
2. `next` 获取 Job。
3. 下载 R2 input。
4. CPU inference。
5. 上传 R2 output。
6. complete。
7. heartbeat 每 60 秒。
8. 失败调用 fail 后继续下一个 Job。
9. empty 后 finish。
10. Worker Run 结束时释放模型缓存和 per-job 临时内存。

## 10. 前端状态请求策略

旧方案每 2.5 秒自动请求：

```text
GET /api/jobs/status
```

当前方案已经完全删除自动轮询和自动 stale check。

### 当前请求规则

- 页面打开：不请求。
- 提交任务成功：刷新一次。
- 开始处理成功：刷新一次。
- 用户点击“刷新任务状态”：请求一次。
- 处理过程中：不自动请求。
- Worker 崩溃后：不自动请求、不自动唤醒。
- 用户手动刷新后：status API 在 DB 内做 stale reconcile，并返回 `failed`。

因此状态查看和 Worker 唤醒完全解耦。

### 后端崩溃时

```text
processing
   ↓
heartbeat 停止
   ↓
120 秒 stale
   ↓
用户手动刷新 /api/jobs/status
   ↓
failed
   ↓
前端显示：✕ 失败
```

错误信息例如：

```text
Worker Run 已失联超过 120 秒，后端可能已停止。
```

## 11. Vercel Build 与 TypeScript

Vercel build 流程：

```text
npm run db:migrate
↓
next build
↓
TypeScript type check
```

最近一次 build 在 `app/api/worker/heartbeat/route.ts` 失败：

```text
Type error: Object is of type 'unknown'.
```

原因是 SQL tagged-template 返回结果在当前类型定义下无法安全推断 `rows[0].lease_expires_at`。

已修复：

```ts
type LeaseRow = { lease_expires_at: Date | string };
const leaseRows = await tx<LeaseRow[]>`...`;
```

修复不改变 SQL、lease 或 heartbeat 行为，仅补充 TypeScript 泛型类型。

**该修复不需要数据库 migration。**

## 12. 手动清除历史记录

新增 API：

```text
POST /api/jobs/reset
```

前端新增按钮：

```text
清除当前历史记录
```

确认后由 Vercel API 清除：

```sql
TRUNCATE TABLE photo_jobs, photo_requests, photo_worker_runs RESTART IDENTITY CASCADE;
```

并恢复：

```text
photo_worker_state.status = idle
photo_worker_state.active_run_id = NULL
```

当前属于开发/调试阶段，正式生产必须增加管理员权限或用户隔离。

## 13. Migration

数据库结构继续由：

```text
db/migrations/*.sql
```

管理。

Vercel build 自动执行：

```text
npm run db:migrate
↓
next build
```

不要把 reset 放入 `vercel-build`。

## 14. 当前开发状态

### 已完成

- Neon Job 模型。
- Vercel Queue publishing/polling。
- R2 SigV4 原图上传。
- 提交/开始分离。
- Worker Run。
- Worker Credential。
- Job claim + lease。
- heartbeat / complete / fail / finish。
- Worker `last_seen_at` liveness。
- Worker 崩溃/失联 → processing Job failed。
- `/api/jobs/status` stale reconcile。
- **前端取消所有自动 `/api/jobs/status` 轮询和单次 stale timer，改为用户手动刷新。**
- Migration 自动化。
- Lightning Studio 直接 FastAPI Debug 模式。
- `/process-queue` 自动追加路径。
- Preview hostname 动态传递到 Lightning。
- Lightning 后端使用 wake payload 的 `vercel_origin` 构造 Bridge 主机地址。
- 添加 CLI `npm run db:reset`。
- 添加前端“清除当前历史记录”与 `POST /api/jobs/reset`。
- 修复 `/api/worker/api/worker/*` 重复 URL 拼接。
- 区分 Vercel Deployment Protection 401 与 Worker Credential 401。
- 修复 `middleware.ts` 对 `/api/worker/*` 的 cookie 鉴权拦截。
- **修复 `app/api/worker/heartbeat/route.ts` 的 Vercel TypeScript build error。**

## 15. 下一步

1. 等待 commit `1af3e2b6e55b3a6f62eef2e10be59a2ddded8de5` 的 Vercel Preview Build。
2. 确认 build 通过。
3. 关闭旧 Preview 标签页，打开最新 Preview。
4. 点击“清除当前历史记录”，确认数据库回到 idle/0 jobs。
5. 提交 1 个任务，手动刷新确认 queued。
6. 点击开始处理。
7. 确认 Lightning 唤醒只发生在 `/api/jobs/start`。
8. 确认 Lightning → `/api/worker/next` → claim → R2 → inference → complete → finish 正常。
9. 故意停止 Lightning，等待超过 120 秒。
10. **手动点击“刷新任务状态”**，确认 Job 变为 failed、Worker 为 idle，并确认没有重新唤醒 Lightning。
11. 再测试正常 3 Job 串行、heartbeat、lease recovery、重复 complete、fail/retry。
12. 最后切回 Lightning Platform Wake 模式。
