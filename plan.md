# AI 证件照生产架构开发计划

## 1. 当前目标

实现 Vercel + Neon + R2 + Vercel Queue + Lightning 的异步生产处理架构：

- 用户先提交任务，任务进入 Queue，但不启动 Lightning。
- 一次选择多个尺寸时，每个尺寸创建一个独立 Job。
- 用户点击“开始处理”后，Vercel 才准备 R2 临时访问信息、创建本次 worker 的短期凭证并唤醒 Lightning。
- Lightning 是无状态 Docker Worker，只在本次运行内存中保存运行参数，严格串行处理 Job。
- Queue 返回 empty 后立即退出，以减少 Lightning/GPU 运行时间。

## 2. 整体流程

```text
用户
 ↓
Vercel / Next.js
 ├─ 提交任务 → Neon + Vercel Queue
 │
 └─ 开始处理
      ├─ 检查 queued / active worker
      ├─ 生成 R2 临时访问信息
      ├─ 创建短期 Worker Credential
      └─ 调用 Lightning 公网 API
             ↓
       Lightning 无状态 Worker
             ↓
       Vercel Queue Bridge
             ↓
          Vercel Queue
             ↓
       串行领取并处理 Job
             ↓
       R2 + Neon 回写
             ↓
       Queue empty → 立即退出
```

## 3. Vercel 环境变量

以下变量配置在 **Vercel 项目**。敏感值不得写入 Git、Queue payload 或日志。

| 变量名 | 作用 |
|---|---|
| `DATABASE_URL` | Neon/PostgreSQL 连接。**实际变量名必须以当前 Neon/Vercel Integration 提供的名称为准**；如果不是 `DATABASE_URL`，同步修改 `lib/db.ts`。 |
| `R2_ACCOUNT_ID` | Cloudflare R2 Account ID。 |
| `R2_ACCESS_KEY_ID` | R2 S3 Access Key ID。 |
| `R2_SECRET_ACCESS_KEY` | R2 S3 Secret Access Key。 |
| `R2_BUCKET_NAME` | R2 Bucket 名称。 |
| `VERCEL_QUEUE_NAME` | Queue 名称，例如 `id-photo-jobs`。 |
| `VERCEL_QUEUE_REGION` | Queue 区域，例如 `iad1`。 |
| `VERCEL_QUEUE_CONSUMER_GROUP` | Queue Consumer Group。 |
| `LIGHTNING_API_URL` | Lightning 平台自动提供的公网 API URL。Vercel 用它调用 Lightning；Lightning 容器自身不配置。 |
| `LIGHTNING_API_KEY` | Lightning 平台提供给外部调用方的 API Key；仅在 Lightning 公网 API 要求认证时配置，由 Vercel 调用 Lightning 时使用。 |

### 短期 Worker Credential

它不是环境变量。用户点击“开始处理”时由 Vercel 动态生成，默认有效期 3 小时，与 `worker_run` 绑定；Neon 只保存 hash、过期时间和状态，明文只在启动 Lightning 时传递一次，并只存在 Lightning 内存中。正常结束后立即失效。

## 4. Lightning 设计

Lightning Docker 是**无状态 Worker**：

- 不配置任何本项目环境变量。
- 不保存 Vercel、Neon、R2 的长期凭证。
- 不保存 Queue 的长期认证信息。
- 不直接使用 Vercel Queue SDK/API。
- 启动时从 Vercel 请求读取 Bridge URL、短期 Credential、`worker_run` 和本次运行所需的临时访问信息。
- 严格一次处理一个 Job。
- Queue empty 后立即退出。

`LIGHTNING_API_URL` 是 Lightning 平台给 Vercel 的公网调用地址，不是 Lightning 自己需要读取的配置。

## 5. Queue Bridge

Lightning 通过 Vercel Server-side Bridge 消费 Queue；Queue SDK/API 及 Vercel 侧认证只存在 Vercel。

Bridge 建议提供三个接口：

- `POST /api/worker/next`：验证短期 Credential，领取一个 Job；没有任务返回 `empty`。
- `POST /api/worker/complete`：幂等记录成功、结果和处理时间，并完成 Queue 消息确认。
- `POST /api/worker/fail`：幂等记录失败并执行重试/失败策略。

Bridge 必须校验 Credential：hash、expiry、revoked 状态以及 `worker_run` scope，并防止两个 Worker 同时领取同一个 Job。

## 6. 任务生命周期

### 提交任务

1. 用户上传图片并选择尺寸。
2. 每个尺寸创建一个 Job；例如 3 个尺寸 = 3 个 Job。
3. Job 写入 Neon，并进入 Vercel Queue。
4. 不启动 Lightning。
5. 不生成处理用 R2 presigned URL。
6. 前端显示 queued 数量，例如“开始处理（9 个任务）”。

### 开始处理

1. 检查 queued Job，并确认没有 active worker。
2. 创建 `worker_run`。
3. 此时才准备本批任务的 R2 临时访问信息。
4. 生成短期 Worker Credential，并只保存 hash。
5. 调用 `LIGHTNING_API_URL`；如需要认证，使用 `LIGHTNING_API_KEY`。
6. 将 Bridge URL、Credential、`worker_run` 和必要的临时访问信息传给 Lightning。
7. Lightning 循环执行：

```text
next → process → complete/fail → next → ... → empty → exit
```

8. Worker 退出后，Vercel 使 Credential 失效。

## 7. R2

R2 保存原图和生成结果，避免大图片经过 Vercel API 中转。

- 提交阶段不生成处理 presigned URL。
- 开始处理后才生成临时访问信息。
- URL 有明确过期时间并覆盖预计处理窗口。
- R2 长期 Secret 只存在 Vercel server-side。

## 8. 前端行为

- “提交任务”：只入队，不启动 Lightning。
- 有 queued Job 且没有 active worker 时显示“开始处理（N 个任务）”。
- 没有 queued Job 或已有 worker 时按钮灰色不可点击。
- 前端轮询 Job 状态并展示结果。
- 根据历史 `processing_time_ms` 估算处理时间，仅用于 UI。

## 9. 数据与可靠性

Neon 至少记录 Job、尺寸/参数、输入输出 R2 object key、状态、处理时间、错误、`worker_run`、Credential hash/expiry/revoked 和 Job claim 信息。

Job 状态至少包括：`queued`、`processing`、`completed`、`failed`。

Queue 按 at-least-once delivery 设计，因此 Job claim、结果写入、complete/fail 必须幂等，并考虑网络重试和重复投递。

## 10. 核心文件

### Vercel：`jiojiojackson/id-photo-front`

分支：`agent/queue-job-architecture`

- `app/page.tsx`：前端 UI、提交、开始处理、状态和结果。
- `app/api/jobs/submit/route.ts`：创建 Job 并入队。
- `app/api/jobs/start/route.ts`：创建 worker、R2 临时访问信息和短期 Credential，调用 Lightning。
- `app/api/jobs/status/route.ts`：任务状态。
- `app/api/worker/next/route.ts`：领取 Job。
- `app/api/worker/complete/route.ts`：成功回写。
- `app/api/worker/fail/route.ts`：失败回写。
- `lib/db.ts`：Neon/Postgres。
- `lib/queue.ts`：Vercel Queue。
- `lib/r2.ts`：R2 和 presigned URL。
- `DEV_STATE.md`：当前实际开发状态。
- `plan.md`：本方案。

### Lightning：`jiojiojackson/id-photo-back`

- Docker inference API。
- `/generate` 等证件照推理 endpoint。
- 无状态串行 Worker。
- 通过 Bridge 领取、完成/失败 Job。
- Queue empty 后立即退出。

## 11. 当前开发状态

已确认/完成：

- 多尺寸拆分为独立 Job。
- 提交与开始处理分离。
- Lightning 串行处理，Queue empty 后立即退出。
- R2 presigned URL 延迟到开始处理阶段。
- Lightning 不保存长期 Vercel/Neon/R2 凭证。
- Vercel 负责 Queue Bridge。
- Vercel 前端此前的 module alias、TypeScript reducer、Job `unit`、R2 Web Crypto 类型问题已修复。

当前未完成：

1. 确认 Neon/Vercel Integration 实际数据库变量名，并修正 `lib/db.ts`；最近 Vercel 部署已确认失败点为 `DATABASE_URL` 未找到。
2. 完成短期 Worker Credential 和 `worker_run` 数据模型。
3. 完成 Queue Bridge 的 `next / complete / fail`。
4. 确认 Lightning 公网 endpoint 和认证要求，并完成 start → Lightning → Bridge 链路。
5. 修改 Lightning 后端实现无状态串行消费。
6. 完成 3 Job、9 Job、失败、重试、重复领取、空队列退出和 R2 回写的端到端测试。
7. 最终验证 Vercel Build、Runtime 和 Lightning 实际推理。

## 12. 下一步开发顺序

1. 先解决实际 Neon 数据库环境变量问题。
2. 完成 Vercel Queue Bridge 和短期 Credential。
3. 完成 `/api/jobs/start` → Lightning 的唤醒链路。
4. 修改 Lightning Worker 为无状态串行消费。
5. 完成端到端测试并检查 Vercel/Lightning 日志。
