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

### 4.3 Job Claim / Lease

为了防止 Worker 崩溃后 Job 永久卡在 `processing`，以及避免两个 Worker 同时处理同一个 Job，Neon 中的 Job 必须使用 **claim + lease**。

领取 Job 时由 Bridge 在数据库事务中完成：

```text
queued Job
   ↓ 原子 claim
processing
   ↓
worker_run_id + lease_expires_at
```

Claim 至少记录：

- `worker_run_id`
- `claimed_at`
- `lease_expires_at`
- `attempt_count`

规则：

- 只有 `queued` Job 或 lease 已过期的 `processing` Job 可以被重新领取。
- 未过期的 Job 不能被其他 Worker claim。
- Claim 必须是数据库原子操作，不能先 SELECT 再 UPDATE，否则两个 Worker 可能同时拿到同一个 Job。
- Lightning 严格串行，所以正常情况下一个 Worker Run 同时只持有一个 active Job lease。
- Job 开始处理前确认 claim 成功；没有 claim 成功就不能执行推理。

### 4.4 Lease 与长任务

Lease 时间必须覆盖单个 Job 的最大合理处理时间，并允许续租。

如果单个推理可能超过初始 lease，Lightning 在处理过程中通过 Bridge 定期 heartbeat/renew lease，例如：

```text
POST /api/worker/heartbeat
```

Heartbeat 只允许对应 `worker_run_id + job_id` 的 Worker 延长自己的 lease。

如果 Worker 长时间没有 heartbeat，lease 到期后 Job 可以被重新领取。

Lease 时间、heartbeat 间隔和最大 Job 时间需要根据实际 Lightning 推理时间测试后确定，不能写死为一个未经测试的值。

### 4.5 Queue Ack

Queue 的消息确认必须和 Job 状态保持一致，避免“数据库显示完成但 Queue 消息未确认”或反过来的情况。

推荐的处理顺序：

```text
Queue message
   ↓
Bridge claim
   ↓
Neon: processing + lease
   ↓
Lightning 推理
   ↓
R2 写入结果
   ↓
Bridge complete
   ├─ 验证 worker/job/lease
   ├─ 幂等写 Neon: completed
   └─ ACK Queue message
```

`complete` 必须幂等：重复调用不会重复生成结果，也不会破坏已完成状态。

**注意：Neon 数据库事务和 Queue ACK 通常不能组成一个真正的跨系统原子事务。** 因此系统必须接受 at-least-once delivery，并通过 Job ID、状态检查和幂等处理解决 ACK/数据库更新之间出现的重复投递。

如果 ACK 失败但 Job 已经 `completed`，再次投递时 Bridge 应发现 Job 已完成并安全确认/结束，而不是再次执行 GPU 推理。

### 4.6 Worker 崩溃恢复

典型情况：

```text
Worker
 ↓
claim Job 5
 ↓
processing
 ↓
GPU 推理
 ↓
Worker 崩溃
```

此时不会立即把 Job 标记失败，而是等待 lease 到期。

随后新的 Worker Run 可以：

```text
lease expired
 ↓
重新 claim Job 5
 ↓
attempt_count + 1
 ↓
重新处理
```

因此：

- 未完成 Job 不会因为 Worker 崩溃永久停留在 `processing`。
- Queue/Bridge 的重投递和数据库 lease 共同保证任务最终有机会再次处理。
- `attempt_count` 用于限制异常 Job 的无限重试。
- 超过最大尝试次数后进入 `failed`，等待人工处理或后续明确的重试策略。

### 4.7 Complete / Fail 的并发保护

`complete` 和 `fail` 必须验证：

```text
job_id
worker_run_id
当前 lease
当前状态
```

例如旧 Worker 崩溃后，新 Worker 已经重新 claim Job；旧 Worker 恢复并发送 `complete` 时，Bridge 必须拒绝旧 lease 的回写，不能覆盖新 Worker 的状态。

因此 Job 状态更新必须使用类似“当前 lease/worker 仍匹配”的条件更新，而不是只根据 `job_id` 更新。

### 4.8 Job 结果幂等

生成结果写入 R2 时使用确定性的 Job/attempt 关联 object key，避免重复请求产生互相覆盖的随机结果。

如果 Worker 重试同一个 Job：

- 已经存在并确认有效的最终结果时，可以直接完成 Job。
- 结果不存在或不完整时才重新推理。
- `complete` 再次调用必须安全。

具体 R2 object key 格式在实现阶段确定，但必须保证 Job ID 可追踪。

### 4.9 异常处理

- **单 Job 推理失败**：记录 `fail`，按重试策略继续下一个 Job。
- **模型加载失败**：Worker Run 结束，不进入无限重试。
- **Bridge 暂时不可用**：有限次数、带退避的重试；超过阈值结束 Worker。
- **R2 临时访问失效**：Job 失败，由 Vercel 重试/重新生成临时访问信息。
- **Worker 异常退出**：lease 到期后重新 claim；依靠 Queue at-least-once/retry 机制获得再次处理机会。
- 禁止无限重试和无限空循环。

## 5. Queue Bridge

Lightning 通过 Vercel Server-side Bridge 消费 Queue；Vercel 的 Queue SDK/API 和平台认证逻辑只存在 Vercel。

Bridge 至少提供：

- `POST /api/worker/next`：验证短期 Credential，原子领取一个 Job；没有任务返回 `empty`。
- `POST /api/worker/heartbeat`：续租当前 Job，防止正常长推理期间 lease 过期。
- `POST /api/worker/complete`：验证 worker/job/lease，幂等记录成功、结果和处理时间，并确认 Queue 消息。
- `POST /api/worker/fail`：验证 worker/job/lease，记录失败并执行重试/失败策略。

Bridge 必须校验 Credential 的 hash、expiry、revoked 状态和 `worker_run` scope，并防止两个 Worker 同时领取同一 Job。

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

- 提交阶段不生成处理用 presigned URL。
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

Neon 至少记录：Job、尺寸/参数、输入输出 R2 object key、状态、处理时间、错误、`worker_run`、Credential hash/expiry/revoked、Job claim/lease、attempt_count。

Job 状态至少包括：`queued`、`processing`、`completed`、`failed`。

Queue 按 at-least-once delivery 设计。Job claim、lease、结果写入、complete/fail 和 Queue ACK 必须按幂等原则实现，并处理网络重试、重复投递和 Worker 崩溃。

## 11. 核心文件

### Vercel：`jiojiojackson/id-photo-front`

分支：`agent/queue-job-architecture`

- `app/page.tsx`：前端 UI、提交、开始处理、状态和结果。
- `app/api/jobs/submit/route.ts`：创建 Job 并入队。
- `app/api/jobs/start/route.ts`：创建 worker、R2 临时访问信息和短期 Credential，调用 Lightning。
- `app/api/jobs/status/route.ts`：任务状态。
- `app/api/worker/next/route.ts`：领取 Job。
- `app/api/worker/heartbeat/route.ts`：续租 Job。
- `app/api/worker/complete/route.ts`：成功回写和 Queue ACK。
- `app/api/worker/fail/route.ts`：失败回写。
- `lib/db.ts`：Neon/Postgres。
- `lib/queue.ts`：Vercel Queue。
- `lib/r2.ts`：R2 和 presigned URL。

### Lightning：`jiojiojackson/id-photo-back`

- Docker inference API。
- `/generate` 等证件照推理 endpoint。
- Worker Run 启动、模型初始化和串行 Job 消费。
- 通过 Bridge 领取、heartbeat、完成/失败 Job。
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
- Job 采用 claim/lease，支持 Worker 崩溃恢复和 at-least-once delivery。
- Queue ACK 与 Neon 状态更新按幂等方式设计。
- Vercel 前端此前的 module alias、TypeScript reducer、Job `unit`、R2 Web Crypto 类型问题已修复。

当前未完成：

1. 确认 Neon/Vercel Integration 实际数据库变量名，并修正 `lib/db.ts`；最近 Vercel 部署已确认失败点为 `DATABASE_URL` 未找到。
2. 完成 Worker Credential、`worker_run`、Job claim/lease 数据模型。
3. 完成 Queue Bridge 的 `next / heartbeat / complete / fail`。
4. 确认 Lightning 公网 endpoint 和认证要求，完成 Vercel → Lightning → Bridge 链路。
5. 在 Lightning 后端实现 Worker Run 生命周期：启动 → 模型加载一次 → 串行 Job → heartbeat → empty → 释放模型 → 退出。
6. 根据实际推理时间确定 lease、heartbeat、Job timeout 和最大 retry 参数。
7. 完成 GPU 内存清理、异常恢复和结果幂等。
8. 完成 3 Job、9 Job、失败、重试、重复领取、Worker 崩溃、Queue ACK 失败、lease 过期、空队列退出和 R2 回写的端到端测试。
9. 最终验证 Vercel Build、Runtime 和 Lightning 实际推理。

## 13. 下一步开发顺序

1. 解决 Neon 实际数据库环境变量问题。
2. 完成 Job claim/lease、`worker_run` 和短期 Credential 数据模型。
3. 完成 Queue Bridge：`next / heartbeat / complete / fail` 以及 Queue ACK。
4. 完成 Vercel → Lightning 唤醒链路。
5. 修改 Lightning 为“模型一次加载、多个 Job 串行复用”的 Worker，并实现 lease heartbeat。
6. 完成 Worker 崩溃恢复、重复投递和结果幂等。
7. 根据实际运行数据调整 timeout/retry/heartbeat 参数。
8. 完成端到端测试并检查 Vercel/Lightning 日志。
