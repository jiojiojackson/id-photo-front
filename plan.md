# AI 证件照生产架构开发计划

## 1. Production 目标架构

```text
用户
 ↓
Vercel
 ├─ /create
 │    ↓ 提交任务
 │    R2 原图 + Neon Job + Queue
 │    （不启动 Lightning）
 │
 ├─ /jobs
 │    ↓ 用户手动刷新
 │    Neon / Queue 状态
 │    ↓ 用户点击开始
 │    /api/jobs/start
 │    ↓
 │    Lightning
 │
 └─ /results
      ↓
      已完成 Job
      ↓
      浏览器 Canvas 调整背景色
      ↓
      下载最终 PNG
```

核心原则：Vercel 负责任务协调，Lightning 负责推理；模型生命周期绑定 Worker Run，而不是单个 Job。

后端 `id-photo-back` 已调试完成，当前 Production UI 完善阶段不修改后端。

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

`/create` 制作页只负责：

1. 用户上传照片。
2. 用户设置 3 个尺寸，可输入自定义数字。
3. 浏览器在提交前压缩照片。
4. POST `/api/jobs/submit`。
5. 原图上传 R2。
6. 创建 `photo_request`。
7. 创建多个 `photo_jobs`。
8. 发布 Queue message。
9. 不启动 Lightning。
10. 不生成 processing presigned URL。

提交阶段不再让用户设置背景色。初始背景由现有 backend default `#ffffff` 处理。

DPI 当前固定发送为 300，不在 Production UI 暴露背景色输入。

## 5. 自定义尺寸输入

旧 UI 使用 number state，并在 `onChange` 中立即调用 `normalize()`，导致用户无法删除当前数字。

现在尺寸输入使用字符串 draft：

```ts
type SizeDraft = {
  width: string;
  height: string;
};
```

用户可以：

- 全选删除。
- 删除到空字符串。
- 输入任意数字。
- 使用常用 preset。

只有点击提交时才验证：

```text
100 <= dimension <= 3000
且必须为整数
```

## 6. 开始处理

`/jobs` 页面显示当前队列。

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

## 7. 动态 Vercel Hostname

**禁止硬编码 `id-photo-front.vercel.app`。** Preview/Production hostname 应根据当前请求动态确定。

Vercel `/api/jobs/start` 使用：

```ts
const vercelOrigin = request.nextUrl.origin;
```

并发送 `vercel_origin` 给 Lightning，同时发送动态 `bridge_url`。

Lightning 后端使用 wake payload 中的 `vercel_origin` 构造 Bridge 地址，并验证 scheme + hostname。

## 8. Queue Bridge

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

## 9. Queue ACK

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

## 10. Lightning Worker

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

## 11. 前端分页 UI

正式 UI 不再把上传、任务、结果全部放在一个长页面。

### `/create`

```text
照片
 ↓
尺寸
 ↓
提交
```

设计重点：

- 大面积上传区域。
- 三个独立尺寸卡片。
- 自定义数字输入。
- 常用尺寸 chip。
- 背景色不在这里出现。
- 提交后进入 `/jobs`。

### `/jobs`

```text
统计卡片
 ↓
Worker 状态
 ↓
任务列表
 ↓
开始处理
```

用户可以在这里：

- 手动刷新状态。
- 点击开始处理。
- 查看失败任务。
- 进入已完成任务的结果编辑页。
- 返回 `/create` 创建新任务。

### `/results`

```text
结果尺寸列表 | 大图预览
              ↓
          背景色工具
              ↓
          下载 PNG
```

已完成结果可以独立选择。

## 12. 结果背景色编辑

生成结果本身不重新调用 Lightning，也不修改数据库中的原始结果。

新增：

```text
GET /api/jobs/image?jobId=...
```

处理流程：

```text
Browser
 ↓
/api/jobs/image
 ↓
Neon 查询 output_key
 ↓
Vercel 生成短期 R2 GET presigned URL
 ↓
Vercel server fetch R2
 ↓
返回 image/png
 ↓
Browser Canvas
```

这样浏览器无需访问 R2 bucket，也不需要 R2 CORS 配置。

背景调整完全在浏览器 Canvas 完成：

1. 读取原结果图片。
2. 采样原背景颜色。
3. 找出接近原背景颜色的像素。
4. 使用目标颜色替换。
5. 对接近阈值的像素进行渐变混合，以减少人物边缘锯齿。
6. 保留 Canvas 结果，不覆盖 R2 原文件。

### 常用背景色

```text
白色       #ffffff
浅灰       #e5e7eb
深灰       #6b7280
证件蓝     #438edb
浅蓝       #9dd7f5
深蓝       #2563eb
米白       #f7f1e3
淡粉       #f5c6cb
```

另外使用原生 HTML color picker 支持自定义颜色。

下载时：

```text
Canvas
 ↓
toBlob("image/png")
 ↓
Object URL
 ↓
浏览器下载
```

因此下载的是用户当前调整后的颜色，而不是原始 R2 图片。

## 13. 前端状态请求策略

自动 `/api/jobs/status` 轮询已经完全删除。

### 当前规则

- `/create` 不查询 status。
- `/jobs` 查询当前任务用于显示队列状态，并提供手动刷新；不设置轮询。
- `/results` 查询一次已完成结果用于显示结果；不设置轮询。
- 开始处理成功后不会启动自动 polling。
- 用户点击“刷新任务状态”时请求一次。
- 处理过程中不自动请求。
- Worker 崩溃后不自动请求、不自动唤醒。
- `/api/jobs/status` stale reconcile 只修改 DB，不产生 Lightning 请求。

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

## 14. Vercel Build 与 TypeScript

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

## 15. 手动清除历史记录

API 继续保留：

```text
POST /api/jobs/reset
```

当前新版主 UI 不再把“清除历史记录”放在制作页，避免破坏 Production 普通用户流程。后续如需要，应在独立设置/管理页面提供，并增加管理员权限或用户隔离。

## 16. Migration

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

本阶段没有数据库 schema 变化，不需要新的 migration。

## 17. 当前开发状态

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
- 前端取消自动 `/api/jobs/status` 轮询。
- Migration 自动化。
- Lightning `/process-queue` 调用。
- Preview/Production hostname 动态传递到 Lightning。
- Lightning 后端使用 wake payload 的 `vercel_origin` 构造 Bridge 主机地址。
- 修复 Worker Bridge middleware 鉴权拦截问题。
- 修复重复 `/api/worker` URL 拼接。
- 修复 `app/api/worker/heartbeat/route.ts` 的 Vercel TypeScript build error。
- Production 前端删除 `DEBUG_DIRECT_BACKEND`。
- Production `/api/jobs/start` 强制使用 `LIGHTNING_API_KEY`。
- **分页 UI：`/create`、`/jobs`、`/results`。**
- **尺寸输入允许清空并重新输入自定义数字。**
- **提交页删除背景色输入。**
- **结果页增加常用背景色、自定义调色盘和 PNG 下载。**
- **增加 `/api/jobs/image` 同源 R2 结果图片代理。**
- **后端 `id-photo-back` 在本次 UI 重构中未修改。**

## 18. Production UI 验证清单

1. Vercel Production 配置 `LIGHTNING_API_URL` 与 `LIGHTNING_API_KEY`。
2. 删除遗留 `DEBUG_DIRECT_BACKEND`。
3. 确认 Production Build 通过。
4. `/create` 尺寸输入框可以全部删除后输入自定义数字。
5. 提交页面不再要求背景色。
6. 提交后进入 `/jobs`，确认不会因为提交而唤醒 Lightning。
7. 点击开始处理，确认 Lightning 被正确唤醒。
8. Worker 正常完成后，进入 `/results`。
9. 在结果页切换不同尺寸。
10. 测试白/蓝/灰等预设背景。
11. 测试自定义颜色 picker。
12. 下载并确认 PNG 为调整后的背景色。
13. 手动刷新任务状态，确认不会访问 Lightning。
14. Worker 崩溃后等待超过 120 秒，手动刷新确认 Job → failed。
15. 回归多 Job、heartbeat、lease recovery、complete、fail/retry。
