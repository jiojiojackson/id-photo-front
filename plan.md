# AI 证件照生产架构开发计划

## 1. 目标架构

实现 Vercel + Neon + R2 + Vercel Queue + Lightning 的异步生产架构：

```text
用户
 ↓
Vercel
 ├─ 提交任务 → R2 原图 + Neon Job + Queue
 │              （不启动 Lightning）
 │
 └─ 开始处理
      ├─ 原子创建 worker_run
      ├─ 创建短期 Worker Credential
      └─ 使用 LIGHTNING_API_URL + 平台 API Key 唤醒 Lightning
              ↓
       Lightning 无状态 Worker
       ├─ 加载模型一次
       ├─ POST /api/worker/next
       ├─ claim + lease
       ├─ R2 输入 GET / 输出 PUT
       ├─ complete / fail
       ├─ heartbeat
       └─ empty → finish → 退出
```

核心原则：**Vercel 负责任务协调，Lightning 负责 GPU 推理；模型生命周期绑定 Worker Run，而不是单个 Job。**

## 2. Vercel 环境变量

只在 Vercel 配置：

| 变量 | 用途 |
|---|---|
| `DATABASE_URL` | Neon/PostgreSQL 连接 |
| `R2_ACCOUNT_ID` | Cloudflare R2 Account ID |
| `R2_ACCESS_KEY_ID` | R2 S3 Access Key |
| `R2_SECRET_ACCESS_KEY` | R2 S3 Secret Key |
| `R2_BUCKET_NAME` | R2 Bucket |
| `VERCEL_QUEUE_NAME` | Queue 名称 |
| `VERCEL_QUEUE_REGION` | Queue 固定区域 |
| `VERCEL_QUEUE_CONSUMER_GROUP` | Polling Consumer Group |
| `LIGHTNING_API_URL` | Lightning 平台自动提供的公网 API URL |
| `LIGHTNING_API_KEY` | Lightning 平台提供给 Vercel 的外部调用凭证 |

**Lightning 容器不配置上述任何项目环境变量。** Lightning 是无状态容器。

`LIGHTNING_API_URL` 不需要在 Lightning 内部配置；Vercel 直接读取平台生成的 URL。

## 3. 提交任务

一次提交多个尺寸时，每个尺寸创建一个独立 Job。

提交阶段：

1. Vercel 接收原图。
2. 使用 R2 SigV4 server-side PUT 直接写入原图。
3. 创建 `photo_request`。
4. 创建多个 `photo_jobs`。
5. 每个 Job 发布到 Vercel Queue。
6. **不启动 Lightning。**
7. **不创建 processing presigned URL。**

这样用户可以长时间停留在队列页面，处理用 URL 不会提前过期。

## 4. 开始处理与短期凭证

点击“开始处理”后：

1. 数据库行锁检查 `photo_worker_state`，防止并发启动多个 Worker。
2. 如果旧 Worker Run 的 credential 已过期，则把旧 Run 标记为 failed，并允许新的 Run 接管已过期 lease。
3. 创建 `photo_worker_runs`。
4. 生成随机 32-byte Worker Credential，只保存 SHA-256 hash。
5. Credential 默认有效 4 小时。
6. Vercel 调用 `LIGHTNING_API_URL`，使用 `LIGHTNING_API_KEY` 作为 Lightning 平台的外部认证。
7. 请求 body 传递：
   - `worker_run_id`
   - `bridge_url`
   - `worker_credential`
   - `worker_credential_expires_at`
8. Lightning 应用本身只使用请求中收到的 credential，不需要任何项目环境变量。

## 5. Queue Bridge

Bridge 位于 Vercel：

- `POST /api/worker/next`
- `POST /api/worker/heartbeat`
- `POST /api/worker/complete`
- `POST /api/worker/fail`
- `POST /api/worker/finish`

所有 Bridge API 都验证短期 Worker Credential。

### 5.1 next

`next` 首先在 Neon 中原子 claim：

```text
queued
  ↓ UPDATE ... FOR UPDATE SKIP LOCKED
processing
  ↓
worker_run_id + claimed_at + lease_expires_at + attempt_count
```

同时允许重新领取 lease 已过期的 `processing` Job。

Claim 成功后才生成本 Job 的：

- R2 input GET presigned URL
- R2 output PUT presigned URL

当前 URL 有效期为 15 分钟；正式生产前根据 Lightning 实际处理时间重新校准。

### 5.2 Lease

当前初始 lease 为 10 分钟，并提供 heartbeat 延长 lease。

这是初始安全值，不视为最终生产参数；应根据真实 Lightning p95 / 最大推理时间测试后调整。

### 5.3 Queue ACK 策略

`PollingQueueClient.receive()` 的 handler 返回即确认 Queue message，因此当前实现不能让 Queue message 一直等待 GPU 推理完成。

因此采用：

```text
Queue message
 ↓
Bridge 原子 claim Job
 ↓
Queue message ACK
 ↓
Lightning GPU 推理
 ↓
complete / fail
```

Neon Job + lease 是真正的任务所有权来源。这样即使 ACK 后 Worker 崩溃，lease 到期后下一次 Worker Run 仍可重新 claim；不会依赖 Queue message 永久保持未 ACK。

## 6. Job 完成 / 失败

### complete

必须同时验证：

- `job_id`
- `worker_run_id`
- `status = processing`
- 当前 lease 未过期

使用条件 UPDATE 防止旧 Worker 覆盖新 Worker。

重复 complete 如果 Job 已 completed，则安全返回幂等成功。

### fail

单 Job 推理失败时：

- `attempt_count < MAX_ATTEMPTS` → 回到 `queued`，允许再次处理。
- 达到最大次数 → `failed`。

当前最大尝试次数为 5。

## 7. Worker 崩溃恢复

```text
Worker
 ↓
claim Job
 ↓
processing + lease
 ↓
Worker 崩溃
 ↓
lease 到期
 ↓
下一次 Worker Run
 ↓
重新 claim
```

`/api/jobs/start` 会同时检查 queued Job 和 lease 已过期的 processing Job，因此可以恢复异常 Worker 留下的任务。

## 8. Worker 生命周期

Lightning 在一个 Worker Run 中：

1. 加载模型一次。
2. 循环调用 `next`。
3. 一次只处理一个 Job。
4. 处理过程中定期 heartbeat。
5. `complete/fail` 后继续 `next`。
6. `empty` 后调用 `finish`。
7. 释放模型/GPU 资源并退出。

禁止每个 Job 重复加载模型。

## 9. 前端状态

服务端 Job 状态：

```text
queued
processing
completed
failed
```

Worker Run 状态：

```text
starting
running
completed
failed
```

前端通过 `/api/jobs/status` 轮询 Neon；不依赖浏览器内存恢复状态。

## 10. 当前开发状态

已完成：

- Neon Job 基础模型
- Vercel Queue publishing / polling
- R2 SigV4 原图上传
- 提交与开始处理分离
- Worker Run
- 短期 Worker Credential
- 原子 Job claim + lease
- heartbeat
- complete / fail 幂等保护
- Worker finish
- R2 processing presigned URL 延迟到 `next`
- Worker 崩溃后的 lease recovery

待完成：

1. 在 Neon 生产数据库执行最新 `db/schema.sql`。
2. 等待最新 Vercel Preview Build 通过 TypeScript / Next.js 编译。
3. Lightning Worker 按上述 Bridge contract 接入短期 credential。
4. Lightning 实际运行 3 Job 串行处理测试。
5. 验证 Worker 崩溃 / lease 过期恢复。
6. 根据真实推理时间校准 lease / heartbeat / presigned URL 有效期。
7. 完成端到端生产测试后再合并到 `main`。
