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
      └─ 生产：使用 LIGHTNING_API_URL + LIGHTNING_API_KEY 唤醒 Lightning
         调试：直接 POST Lightning Studio FastAPI /process-queue
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

## 2. 环境变量与密钥边界

### Vercel 生产

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
| `LIGHTNING_API_URL` | Lightning 平台生成的公网 API URL |
| `LIGHTNING_API_KEY` | Vercel 唤醒 Lightning 使用的外部调用凭证 |

### Vercel 调试模式

临时在 Lightning Studio Linux 服务器直接运行 FastAPI 时：

```text
DEBUG_DIRECT_BACKEND=true
LIGHTNING_API_URL=https://<Lightning-Studio-public-url>
```

此时：

- 不需要 `LIGHTNING_API_KEY`。
- Vercel 不发送 Lightning 平台 Authorization header。
- `LIGHTNING_API_URL` 自动指向 `/process-queue`。
- Worker Credential 仍然生成并发送给 FastAPI，因为它用于 FastAPI → Vercel Bridge 的 Bearer Authentication，不能删除。

### Lightning Studio 调试服务器

FastAPI 本身不需要：

- `LIGHTNING_API_KEY`
- `DATABASE_URL`
- R2 credentials
- Vercel Queue credentials

它只使用 wake body 中临时收到的：

- `worker_run_id`
- `bridge_url`
- `worker_credential`
- `worker_credential_expires_at`

生产 Lightning 平台仍然保持原设计：平台 API Key 只用于 Vercel → Lightning Wake，不进入 Worker 应用逻辑。

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

## 4. 开始处理与 Worker Run

点击“开始处理”后：

1. 数据库行锁检查 `photo_worker_state`，防止并发启动多个 Worker。
2. 如果旧 Worker Run 的 credential 已过期、已经结束或 stale，则允许新的 Run 接管可恢复 Job。
3. 创建 `photo_worker_runs`。
4. 生成随机 Worker Credential，只保存 SHA-256 hash。
5. Credential 默认有效 4 小时。
6. 生产模式调用 `LIGHTNING_API_URL`，使用 `LIGHTNING_API_KEY` 作为 Lightning 平台外部认证。
7. 调试模式直接 POST Lightning Studio FastAPI，不发送平台 API Key。
8. 请求 body 传递：
   - `worker_run_id`
   - `bridge_url`
   - `worker_credential`
   - `worker_credential_expires_at`
9. Lightning 应用只使用请求中收到的 credential，不需要项目环境变量。

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

当前初始 lease 为 10 分钟，Worker 在处理 Job 时每 60 秒发送 heartbeat 以延长 lease。

这是初始参数，不视为最终生产参数；应根据真实 Lightning p95 / 最大推理时间测试后调整。

### 5.3 Queue ACK 策略

`PollingQueueClient.receive()` 的 handler 返回即确认 Queue message，因此当前实现不能让 Queue message 一直等待 GPU 推理完成。

采用：

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

Neon Job + lease 是真正的任务所有权来源。Worker 崩溃后，lease 到期后下一次 Worker Run 仍可重新 claim，不依赖 Queue message 永久保持未 ACK。

## 6. Lightning Worker 当前实现

`id-photo-back` 已按照本计划实现 Worker Contract，当前位于 `agent/queue-worker-bridge`，并已有 Draft PR #2。

### 6.1 Wake

Lightning `/process-queue` 接收：

- `worker_run_id`
- `bridge_url`
- `worker_credential`
- `worker_credential_expires_at`

后端同时暂时兼容 camelCase，但正式 Contract 使用 snake_case。

生产平台 Wake：

```text
Vercel → Lightning platform URL → /process-queue
```

调试模式：

```text
Vercel → Lightning Studio FastAPI public URL → /process-queue
```

### 6.2 Worker 循环

一个 Worker Run：

1. 启动后复用已经初始化的 `IDCreator`。
2. `POST /api/worker/next` 获取一个 Job。
3. 下载 `inputUrl`。
4. GPU 推理。
5. 上传到 `outputUrl`。
6. `POST /api/worker/complete`。
7. 继续 `next`。
8. 推理期间每 60 秒 heartbeat。
9. 单 Job 失败则 `POST /api/worker/fail`，然后继续下一个 Job。
10. `next` 返回 `empty` 后 `POST /api/worker/finish`。

GPU inference 使用串行锁，当前 Worker Run 不并行处理多个 Job。

## 7. Job 完成 / 失败

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

## 8. Worker 崩溃恢复

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

## 9. Worker 生命周期

Lightning 在一个 Worker Run 中：

1. 模型进程启动时初始化一次。
2. 循环调用 `next`。
3. 一次只处理一个 Job。
4. 处理过程中定期 heartbeat。
5. `complete/fail` 后继续 `next`。
6. `empty` 后调用 `finish`。
7. Worker Run 结束。

禁止每个 Job 重复加载模型。

## 10. Lightning Studio 直接启动调试方案

当前调试阶段不使用 Docker，也不经过 Lightning 平台 Wake API。

### 启动

在 Lightning Studio Linux 服务器：

```bash
cd /path/to/id-photo-back
python3 -m pip install -r requirements.txt
python3 -m pip install "fastapi[standard]" python-multipart pillow
python3 -m uvicorn api_server:app --host 0.0.0.0 --port 8000
```

如果依赖已经安装：

```bash
python3 -m uvicorn api_server:app --host 0.0.0.0 --port 8000
```

### 验证

```text
GET /health
GET /
```

然后从 Vercel 调用：

```text
POST /process-queue
```

FastAPI 会在后台线程启动 Worker，HTTP 请求快速返回 200。

### 注意

这里“不使用 Lightning API Key”只针对：

```text
Vercel → Lightning Studio FastAPI
```

不能删除：

```text
worker_credential
```

因为它仍然用于：

```text
Lightning Studio Worker → Vercel Bridge
```

## 11. 数据库 Migration 自动化

生产数据库不再依赖手动执行 `db/schema.sql`。

新的结构必须新增编号 migration：

```text
db/migrations/001_initial.sql
db/migrations/002_xxx.sql
...
```

Vercel build：

```text
Git push
 ↓
npm run db:migrate
 ↓
schema_migrations + advisory lock
 ↓
执行未应用 migration
 ↓
next build
 ↓
部署
```

Migration 失败则 Build 失败，避免代码与数据库结构不匹配。

## 12. 前端状态

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

## 13. 当前开发状态

### 已完成

- Neon Job 基础模型
- Vercel Queue publishing / polling
- R2 SigV4 原图上传
- 提交与开始处理分离
- Worker Run
- 短期 Worker Credential
- 原子 Job claim + lease
- heartbeat Bridge
- complete / fail / finish Bridge
- R2 processing presigned URL 延迟到 `next`
- Worker 崩溃后的 lease recovery 代码
- 数据库 migration 自动化
- Lightning Worker 与当前 Bridge Contract 的后端实现
- Lightning Worker 串行推理、heartbeat、complete/fail/finish 生命周期代码
- Lightning Wake URL 自动规范化为 `/process-queue`
- Lightning Studio 直接 FastAPI 调试模式

### 待完成

1. 在 Lightning Studio 直接运行后端并完成 1 Job 端到端调试。
2. 验证 `next` 的 Worker Credential 401 是否在直接 FastAPI 模式下仍存在。
3. 如果认证通过，继续验证 R2 input/output、GPU inference、complete、finish。
4. 真实执行 3 Job 串行端到端测试。
5. 测试重复点击开始、Worker 崩溃、lease 到期、重复 complete、单 Job fail/retry。
6. 测量真实 Lightning p95 / 最大推理时间。
7. 根据实际数据校准 lease、heartbeat、presigned URL 有效期。
8. 调试链路稳定后切回生产 Lightning 平台 Wake 模式，重新处理此前平台模式的 Credential 401。
9. 验证生产链路后，合并后端 Draft PR #2 和前端分支到 `main`。
