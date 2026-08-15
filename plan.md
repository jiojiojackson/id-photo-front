# AI 证件照生产架构开发计划

## 1. Production 目标架构

```text
用户
 ↓
Vercel
 ├─ 提交任务 → R2 原图 + Neon Job + Queue
 │              （不启动 Lightning）
 │
 └─ 用户点击开始处理
      ├─ 原子创建 Worker Run
      ├─ 创建短期 Worker Credential
      └─ 使用 LIGHTNING_API_KEY 唤醒 Lightning
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

后端 `id-photo-back` 已调试完成，当前 Production 收敛阶段不修改后端。

## 2. API 访问边界

### 唤醒 Lightning

只有：

```text
用户点击“开始处理”
    ↓
POST /api/jobs/start
    ↓
POST LIGHTNING_API_URL/process-queue
Authorization: Bearer LIGHTNING_API_KEY
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

## 3. Production 环境变量

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

`DEBUG_DIRECT_BACKEND` 已从正式代码删除，Production 不再支持 Debug Direct Backend 模式。如果 Vercel Project Settings 中还存在旧变量，应删除。

Lightning 应用本身不读取项目级 Database、R2、Queue 或 `LIGHTNING_API_KEY` 环境变量。Vercel → Lightning 使用 `LIGHTNING_API_KEY` 认证；Lightning → Vercel Bridge 使用 wake payload 中的短期 Worker Credential。

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
5. 使用 `LIGHTNING_API_KEY` 唤醒 Lightning Platform。
6. 请求固定使用：

```http
Authorization: Bearer <LIGHTNING_API_KEY>
```

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

## 6. 动态 Vercel Hostname

**禁止硬编码 `id-photo-front.vercel.app`。** Preview/Production hostname 应根据当前请求动态确定。

Vercel `/api/jobs/start` 使用：

```ts
const vercelOrigin = request.nextUrl.origin;
```

并发送 `vercel_origin` 给 Lightning，同时发送动态 `bridge_url`。

Lightning 后端使用 wake payload 中的 `vercel_origin` 构造 Bridge 地址，并验证 scheme + hostname。

## 7. Queue Bridge

所有 Bridge API 使用短期 Worker Credential。

`next` 使用 Neon transaction + `FOR UPDATE SKIP LOCKED` claim Job，并设置 lease。

Claim 成功后才生成 R2 input/output presigned URL。

当前参数：

```text
lease = 10 分钟
heartbeat = 60 秒
presigned URL = 15 分钟
MAX_ATTEMPTS = 5
Worker stale = 120 秒
```

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

用户下一次手动请求 `/api/jobs/status` 时执行 reconcile：

```text
active Worker Run
      ↓
credential expired OR last_seen_at <= 120s 未更新
      ↓
processing Jobs → failed
Worker Run → failed
Worker State → idle
```

Worker 整体崩溃/失联直接显示失败，不自动重新排队，也不自动重新唤醒 Lightning。

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

自动 `/api/jobs/status` 轮询已经完全删除。

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
前端显示失败
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

此前 `app/api/worker/heartbeat/route.ts` 因 SQL tagged-template 查询结果被推断为 `unknown[]`，访问 `rows[0].lease_expires_at` 导致 build failure。

已修复为：

```ts
type LeaseRow = { lease_expires_at: Date | string };
const leaseRows = await tx<LeaseRow[]>`...`;
```

修复不改变 SQL、lease 或 heartbeat 行为，仅补充 TypeScript 类型；不需要数据库 migration。

## 12. 手动清除历史记录

保留：

```text
POST /api/jobs/reset
```

前端按钮：

```text
清除当前历史记录
```

确认后由 Vercel API 清除开发/调试阶段的当前历史数据，并恢复 Worker State 为 idle。

该功能属于管理性质操作，正式面向多用户生产环境前应增加管理员权限或用户隔离。

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

Production 收敛阶段没有数据库 schema 变化，不需要新的 migration。

## 14. 当前开发状态

### 已完成

- Neon Job 模型。
- Vercel Queue publishing/polling。
- R2 SigV4 原图上传。
- 提交/开始分离。
- Worker Run。
- 短期 Worker Credential。
- Job claim + lease。
- heartbeat / complete / fail / finish。
- Worker `last_seen_at` liveness。
- Worker 崩溃/失联 → processing Job failed。
- `/api/jobs/status` stale reconcile。
- 前端取消所有自动 `/api/jobs/status` 轮询和自动 stale timer，改为用户手动刷新。
- Migration 自动化。
- Lightning `/process-queue` 调用。
- Preview/Production hostname 动态传递到 Lightning。
- Lightning 后端使用 wake payload 的 `vercel_origin` 构造 Bridge 主机地址。
- 前端“清除当前历史记录”与 `POST /api/jobs/reset`。
- 修复 Worker Bridge middleware 鉴权拦截问题。
- 修复重复 `/api/worker` URL 拼接。
- 修复 `app/api/worker/heartbeat/route.ts` 的 Vercel TypeScript build error。
- **Production 前端已删除 `DEBUG_DIRECT_BACKEND`。**
- **Production `/api/jobs/start` 已强制使用 `LIGHTNING_API_KEY`，并以 Bearer Header 唤醒 Lightning。**
- **后端 `id-photo-back` 在本次 Production 收敛中未修改。**

## 15. Production 收敛提交

Frontend `agent/queue-worker-bridge`：

```text
1af3e2b6e55b3a6f62eef2e10be59a2ddded8de5
```

修复 Vercel TypeScript build error。

正式版收敛提交：

```text
da10e349af270e7e5546d4a82bd7ff9b64d30dc3
```

包含：

1. 删除 `DEBUG_DIRECT_BACKEND`。
2. 强制 `LIGHTNING_API_KEY`。
3. 使用 `Authorization: Bearer <LIGHTNING_API_KEY>` 唤醒 Lightning。
4. 保留 Worker Credential / Bridge / 动态 Vercel origin / stale reconcile。
5. 不修改后端仓库。

文档同步提交：本次更新 `DEV_STATE.md` 与 `plan.md`。

## 16. Production 上线检查

1. Vercel Production 配置 `LIGHTNING_API_URL`。
2. Vercel Production 配置 `LIGHTNING_API_KEY`。
3. 删除 Vercel Project Settings 中遗留的 `DEBUG_DIRECT_BACKEND`（如果存在）。
4. 确认 Production Build 通过。
5. 提交任务，确认不会唤醒 Lightning。
6. 点击开始处理，确认 `/api/jobs/start` 使用 Bearer API Key 唤醒 Lightning。
7. 确认 Lightning → `/api/worker/next` → claim → R2 → inference → complete → finish 正常。
8. 手动刷新状态，确认不会产生 Lightning 请求。
9. 停止 Lightning Worker，等待超过 120 秒后手动刷新，确认 Job → failed、Worker State → idle，且不会自动重新唤醒 Lightning。
10. 回归测试多 Job 串行、heartbeat、lease recovery、重复 complete、fail/retry。

Production 上线后，后端 `id-photo-back` 不需要因为本次前端正式化而修改。
