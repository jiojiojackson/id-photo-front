# AI 证件照生产架构开发计划

## 1. 当前目标

实现 Vercel + Neon + R2 + Vercel Queue + Lightning 的异步生产架构：用户先提交任务进入 Queue，不启动 Lightning；点击“开始处理”后由 Vercel 唤醒 Lightning；Lightning 在一次 Worker Run 中加载模型一次，然后连续串行处理 Queue 中的 Job；Queue empty 后立即退出。

核心原则：**Vercel 负责任务协调，Lightning 负责 GPU 推理；模型生命周期绑定 Worker Run，而不是单个 Job。**

## 2. 整体流程

```text
用户
 ↓
Vercel / Next.js
 ├─ 提交任务 → Neon + Vercel Queue
 │
 └─ 开始处理
      ├─ 创建 worker_run
      ├─ 生成 R2 临时访问信息
      ├─ 创建短期 Worker Credential
      └─ 调用 Lightning API
             ↓
       Lightning 无状态 Worker
       ├─ 加载模型一次
       ├─ next Job
       ├─ 推理 → complete/fail
       ├─ next Job
       ├─ 推理 → complete/fail
       └─ empty → 释放模型 → 退出
```

## 3. Vercel 环境变量

以下变量配置在 **Vercel 项目**：

| 变量名 | 作用 |
|---|---|
| `DATABASE_URL` | Neon/PostgreSQL 连接。实际名称必须以当前 Neon/Vercel Integration 提供的名称为准，并与 `lib/db.ts` 一致。 |
| `R2_ACCOUNT_ID` | Cloudflare R2 Account ID。 |
| `R2_ACCESS_KEY_ID` | R2 S3 Access Key ID。 |
| `R2_SECRET_ACCESS_KEY` | R2 S3 Secret Access Key。 |
| `R2_BUCKET_NAME` | R2 Bucket 名称。 |
| `VERCEL_QUEUE_NAME` | Queue 名称。 |
| `VERCEL_QUEUE_REGION` | Queue 区域。 |
| `VERCEL_QUEUE_CONSUMER_GROUP` | Queue Consumer Group。 |
| `LIGHTNING_API_URL` | Lightning 平台自动提供的公网 API URL；Vercel 用它唤醒 Lightning。 |
| `LIGHTNING_API_KEY` | Lightning 平台提供给外部调用方的 API Key；仅当 Lightning 公网 API 要求认证时使用。 |

Lightning 容器本身不配置这些项目环境变量。

## 4. Lightning 后端设计

### 4.1 Worker Run 生命周期

每次 Vercel 唤醒 Lightning 都创建一个独立 Worker Run：

1. 接收 `worker_run`、Queue Bridge URL、短期 Worker Credential 和本次运行所需的临时 R2 访问信息。
2. 初始化推理环境。
3. **模型只加载一次。**
4. 模型保持在进程/GPU 内存中，供整个 Worker Run 复用。
5. 严格一次处理一个 Job。
6. Queue Bridge 返回 `empty` 后释放模型、清理 GPU/内存资源并退出。

### 4.2 Job 处理循环

```text
next
 ↓
领取一个 Job
 ↓
读取 R2 输入
 ↓
使用已加载模型推理
 ↓
写入 R2 输出
 ↓
complete / fail
 ↓
next
 ↓
...
 ↓
empty
 ↓
退出
```

每个 Job **不得重新加载模型或重新初始化 GPU 推理环境**。

每个 Job 完成后只清理该 Job 的图片、tensor、buffer 等临时资源，不能释放共享模型。必须避免 GPU memory 随 Job 数量持续增长。

### 4.3 异常处理

- **单 Job 推理失败**：记录 `fail`，按重试策略继续下一个 Job。
- **模型加载失败**：Worker Run 结束，不进入无限重试。
- **Bridge 暂时不可用**：有限次数、带退避的重试；超过阈值结束 Worker。
- **R2 临时访问失效**：Job 失败，由 Vercel 重试/重新生成临时访问信息。
- **Worker 异常退出**：依靠 Queue 的 at-least-once/retry 机制重新获得未完成 Job。
- 禁止无限重试和无限空循环。

## 5. Queue Bridge

Lightning 通过 Vercel Server-side Bridge 消费 Queue；Vercel 的 Queue SDK/API 和平台认证逻辑只存在 Vercel。

Bridge 至少提供：

- `POST /api/worker/next`：验证短期 Credential，原子领取一个 Job；没有任务返回 `empty`。
- `POST /api/worker/complete`：幂等记录成功、结果和处理时间，并确认 Queue 消息。
- `POST /api/worker/fail`：幂等记录失败并执行重试/失败策略。

Bridge 必须校验 Credential 的 hash、expiry、revoked 状态和 `worker_run` scope，并防止两个 Worker 同时领取同一个 Job。

## 6. Worker Credential

用户点击“开始处理”时，Vercel 动态生成高熵随机短期 Credential，默认有效期 3 小时，与 `worker_run` 绑定。

- Neon 只保存 Credential hash、expiry 和状态。
- 明文只通过启动请求传给当前 Lightning Run，并只存在内存。
- 正常完成后立即失效。
- Credential 只能访问对应 `worker_run` 的 Bridge。
- 它不是 Vercel API Token，也不是长期 Queue 凭证。

## 7. Vercel 任务流程

### 提交任务

1. 用户上传图片并选择尺寸。
2. 每个尺寸创建一个独立 Job；例如 3 个尺寸 = 3 个 Job。
3. Job 写入 Neon，并进入 Vercel Queue。
4. 不启动 Lightning。
5. 不生成处理用 presigned URL。

### 开始处理

1. 检查 queued Job，并确认没有 active worker。
2. 创建 `worker_run`。
3. 此时生成本批任务需要的 R2 临时访问信息。
4. 创建 Worker Credential。
5. 调用 `LIGHTNING_API_URL`；需要认证时使用 `LIGHTNING_API_KEY`。
6. 将 Bridge URL、Credential、`worker_run` 和必要的临时访问信息传给 Lightning。
7. Lightning 加载模型一次并开始串行消费。

## 8. R2

R2 保存原图和生成结果，避免大图片经过 Vercel API 中转。

- 提交阶段不生成处理 presigned URL。
- 开始处理后才生成临时访问信息。
- 长期 R2 Secret 只存在 Vercel server-side。
- Lightning 只获得当前 Worker Run 所需的临时访问信息。

## 9. 前端行为

- “提交任务”：只入队，不启动 Lightning。
- 有 queued Job 且没有 active worker 时显示“开始处理（N 个任务）”。
- 没有 queued Job 或已有 worker 时按钮灰色不可点击。
- 前端轮询 Job 状态并展示结果。
- 根据历史 `processing_time_ms` 估算处理时间，仅用于 UI。

## 10. 数据与可靠性

Neon 至少记录：Job、尺寸/参数、输入输出 R2 object key、状态、处理时间、错误、`worker_run`、Credential hash/expiry/revoked 和 Job claim 信息。

Job 状态至少包括：`queued`、`processing`、`completed`、`failed`。

Queue 按 at-least-once delivery 设计，因此 Job claim、结果写入、complete/fail 必须幂等，并处理网络重试和重复投递。

## 11. 核心文件

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

### Lightning：`jiojiojackson/id-photo-back`

- Docker inference API。
- `/generate` 等证件照推理 endpoint。
- Worker Run 启动、模型初始化和串行 Job 消费。
- 通过 Bridge 领取、完成/失败 Job。
- Queue empty 后释放模型并退出。

## 12. 当前开发状态

已确认/完成：

- 多尺寸拆分为独立 Job。
- 提交与开始处理分离。
- Lightning 串行处理。
- Queue empty 后立即退出。
- 模型在 Worker Run 中只加载一次并复用。
- R2 临时访问延迟到开始处理阶段。
- Lightning 不保存长期 Vercel/Neon/R2 凭证。
- Vercel 负责 Queue Bridge。
- Vercel 前端此前的 module alias、TypeScript reducer、Job `unit`、R2 Web Crypto 类型问题已修复。

当前未完成：

1. 确认 Neon/Vercel Integration 实际数据库变量名，并修正 `lib/db.ts`；最近 Vercel 部署已确认失败点为 `DATABASE_URL` 未找到。
2. 完成 Worker Credential 和 `worker_run` 数据模型。
3. 完成 Queue Bridge 的 `next / complete / fail`。
4. 确认 Lightning 公网 endpoint 和认证要求，完成 Vercel → Lightning → Bridge 链路。
5. 在 Lightning 后端实现 Worker Run 生命周期：启动 → 模型加载一次 → 串行 Job → empty → 释放模型 → 退出。
6. 完成 GPU 内存清理、Job 超时、Bridge 重试和失败策略。
7. 完成 3 Job、9 Job、失败、重试、重复领取、空队列退出和 R2 回写的端到端测试。
8. 最终验证 Vercel Build、Runtime 和 Lightning 实际推理。

## 13. 下一步开发顺序

1. 解决 Neon 实际数据库环境变量问题。
2. 完成 Vercel Queue Bridge、`worker_run` 和短期 Credential。
3. 完成 Vercel → Lightning 唤醒链路。
4. 修改 Lightning 为“模型一次加载、多个 Job 串行复用”的 Worker。
5. 完成异常、重试和 GPU 内存清理。
6. 完成端到端测试并检查 Vercel/Lightning 日志。
