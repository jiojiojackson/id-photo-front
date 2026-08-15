# AI 证件照 Vercel + Lightning 最终开发方案

## 1. 目标

构建一个“提交任务”和“开始处理”完全分离的生产任务系统：用户先上传照片并设置多个尺寸；一次输入 3 个尺寸就创建 3 个独立 Job，写入 Neon 和 Vercel Queue，但不启动 Lightning，也不生成处理用的 R2 presigned URL。用户点击“开始处理”后，Vercel 才准备本批任务的临时 R2 访问信息、生成一次性的短期 Worker Credential，并调用 Lightning 平台提供的公网 URL。Lightning 作为无状态 Docker worker，严格串行处理 Job；每完成一个 Job 再领取下一个，Queue 返回 empty 后立即退出，以尽可能减少按运行时间/GPU 时间产生的费用。

## 2. 最终架构

```text
用户
  │
  ▼
Vercel / Next.js
  │
  ├─ 提交任务 → Neon + Vercel Queue
  │
  └─ 点击“开始处理”
       │
       ├─ 检查 queued / active worker
       ├─ 生成本批 R2 临时访问信息
       ├─ 生成短期 Worker Credential
       └─ 调用 Lightning 平台公网 API URL
             │
             │ 传入 Bridge URL + 短期 Credential + worker_run
             ▼
       Lightning 无状态 Docker
             │
             ├─ next → Vercel Queue Bridge → Vercel Queue
             ├─ 串行处理 1 个 Job
             ├─ /generate
             ├─ R2
             ├─ complete / fail → Bridge → Neon
             ├─ 再 next
             └─ empty → 立即退出
```

Lightning 不直接连接 Vercel Queue，不保存 Vercel Queue 的长期认证信息，不保存数据库/R2/Lightning API 的长期 Secret。Vercel Queue 的 SDK/API 认证只留在 Vercel server-side Bridge 中。

## 3. Vercel 环境变量：最终清单

以下变量需要配置在 **Vercel 项目**中。敏感值只存 Vercel Environment Variables，不写入代码、Git、Queue payload 或日志。

| 变量名 | 必需 | 作用 | 使用方 |
|---|---|---|---|
| `DATABASE_URL` | 取决于 Neon Integration 实际注入名称 | Neon/PostgreSQL 连接字符串，用于 Job、worker run、Credential hash、状态和结果记录。当前项目必须以 Vercel/Neon 实际提供的变量名为准，不能猜测。 | Vercel server-side |
| `R2_ACCOUNT_ID` | 是 | Cloudflare R2 Account ID，用于 R2 服务端操作和 presigned URL。 | Vercel server-side |
| `R2_ACCESS_KEY_ID` | 是 | R2 S3 API Access Key ID。 | Vercel server-side |
| `R2_SECRET_ACCESS_KEY` | 是 | R2 S3 API Secret Access Key。 | Vercel server-side |
| `R2_BUCKET_NAME` | 是 | 保存原图和生成结果的 R2 Bucket。 | Vercel server-side |
| `VERCEL_QUEUE_NAME` | 是 | Queue 名称，例如 `id-photo-jobs`。 | Vercel Queue Bridge |
| `VERCEL_QUEUE_REGION` | 是 | Queue 区域配置，例如 `iad1`。 | Vercel Queue Bridge |
| `VERCEL_QUEUE_CONSUMER_GROUP` | 是 | Queue Consumer Group 名称，用于本项目 worker 消费组。 | Vercel Queue Bridge |
| `LIGHTNING_API_URL` | 是 | **Lightning 平台自动提供的公网 API URL**。Vercel 使用它唤醒/调用 Lightning。这个变量需要配置在 Vercel，因为调用方是 Vercel；**Lightning Docker 容器自身不配置它**。 | Vercel → Lightning |
| `LIGHTNING_API_KEY` | 如果 Lightning 公网 API 要求认证则是 | **Lightning 平台生成、提供给外部调用方的 API Key**。Vercel 调用 Lightning 公网 API 时使用。Lightning Docker 应用自身不配置它，也不自行设计这套认证。 | Vercel → Lightning |

### 3.1 关于 Neon 数据库变量

当前项目已经连接 Neon，但如果 Neon/Vercel Integration 自动注入的变量名称不是 `DATABASE_URL`，`lib/db.ts` 必须使用实际变量名或兼容实际注入的变量。不得根据常见命名猜测。该问题需要在部署环境中确认后处理。

### 3.2 不属于环境变量的运行时凭证

`WORKER_CREDENTIAL` 不预先配置在 Vercel，也不配置在 Lightning。用户点击“开始处理”时，Vercel 动态生成一个高熵随机短期凭证；只保存 hash、过期时间和 worker_run scope，明文只通过本次 Lightning 启动请求传递。

## 4. Lightning 侧：完全无状态

Lightning Docker **不需要人为配置任何本项目环境变量**。尤其不配置：

- `LIGHTNING_API_URL`
- `LIGHTNING_API_KEY`
- `VERCEL_QUEUE_NAME`
- `VERCEL_QUEUE_REGION`
- `VERCEL_QUEUE_CONSUMER_GROUP`
- `VERCEL_WORKER_SECRET`
- Vercel API Token / OIDC Token
- Neon 数据库凭证
- R2 Secret

`LIGHTNING_API_URL` 是 Lightning 平台提供给 Vercel 的公网调用地址；`LIGHTNING_API_KEY`（如果平台要求）也是给 Vercel → Lightning 使用的。Lightning 应用只实现自己的业务 endpoint，例如 `/generate`，以及本方案所需的 worker 处理入口。

每次唤醒时，Vercel 在 HTTP 请求中传入本次运行所需的：

- Queue Bridge URL
- 短期 Worker Credential
- `worker_run` / batch ID
- 本次运行所需的 R2 临时访问信息或 Job 访问信息
- 其他必要的非敏感运行参数

Lightning 只把这些信息保存在当前进程内存中；本次运行结束后容器退出，不持久化这些信息。

## 5. Lightning → Vercel 的短期凭证

不使用长期 `VERCEL_WORKER_SECRET`。

点击“开始处理”时：

1. Vercel 使用密码学安全随机数生成一次短期 Credential。
2. Vercel 只将 Credential 的 hash 保存到 Neon。
3. Credential 与 `worker_run`/batch 绑定，并设置过期时间；当前设计默认 3 小时。
4. Vercel 记录 expiry、scope、active/revoked 状态。
5. Vercel 调用 Lightning 时，将明文 Credential 和 Queue Bridge URL 放入启动请求。
6. Lightning 只在内存中保存 Credential。
7. Lightning 调用 Bridge 时使用 `Authorization: Bearer <credential>`。
8. Bridge 验证 hash、expiry、revoked 状态以及 worker_run scope。
9. 验证通过后才允许 `next`、`complete`、`fail`。
10. Queue 空后 worker 结束，Vercel 立即撤销/标记该 Credential；即使未到 3 小时也不能继续使用。

Credential 不进入 Queue Job payload、不返回浏览器、不写入日志、不写入 R2、不写入 Git。

## 6. Queue Bridge

Lightning 不直接使用 Vercel Queue SDK/API。Vercel server-side Bridge 才是真正的 Queue consumer，在 Vercel 环境内调用官方 Queue SDK，并处理平台认证/consumer 上下文。

建议接口：

### `POST /api/worker/next`

验证短期 Credential 后领取一个 Job。必须防止两个 worker 同时领取同一 Job，并返回处理该 Job 所需的临时访问信息。没有可处理 Job 时返回明确的 `empty`。

### `POST /api/worker/complete`

验证 Credential 和 worker_run scope，幂等地记录成功状态、结果对象和处理时间，并完成 Queue 消息确认所需的操作。

### `POST /api/worker/fail`

验证 Credential 和 worker_run scope，记录错误并按重试策略决定重新入队或最终失败；必须幂等。

## 7. 提交任务

1. 用户上传照片。
2. 设置多个尺寸、DPI、背景等参数。
3. 点击“提交任务（加入队列）”。
4. 每个尺寸创建一个独立 Job；3 个尺寸就是 3 个 Job。
5. Job 元数据写入 Neon。
6. Job 消息进入 Vercel Queue。
7. 不启动 Lightning。
8. 不生成处理用 R2 presigned URL。
9. 前端显示 queued 数量，例如“开始处理（9 个任务）”。

## 8. 开始处理

1. 用户点击“开始处理（N 个任务）”。
2. Vercel 检查 queued Job，并确认没有 active worker run。
3. 创建 worker_run/batch 记录。
4. 此时才为本批 Job 准备 R2 临时访问信息；URL 必须覆盖预计处理时间并留有余量。
5. 生成短期 Worker Credential，默认有效期 3 小时，只保存 hash。
6. Vercel 调用 `LIGHTNING_API_URL` 对应的 Lightning 公网 API；如平台要求认证，使用 Vercel 的 `LIGHTNING_API_KEY`。
7. 启动请求传入 Bridge URL、短期 Credential、worker_run ID 和必要的临时访问信息。
8. Lightning 启动并将 Credential 保存在内存。
9. Lightning 调用 `/api/worker/next`。
10. Bridge 验证 Credential，并在 Vercel 环境内从 Queue 领取一个 Job。
11. Lightning 严格只处理一个 Job。
12. Lightning 调用自己的 `/generate` 完成推理。
13. 结果写入 R2。
14. Lightning 调用 `complete`；失败调用 `fail`。
15. Lightning 再次 `next`。
16. 重复直到 Bridge 返回 `empty`。
17. Lightning 立即退出，不等待 15 秒或其他固定时间。
18. Vercel 完成 worker_run 并撤销短期 Credential。
19. 前端继续轮询并显示结果。

## 9. 串行、可靠性和幂等

Lightning 每次只处理一个 Job：

```text
next → process → complete/fail → next → ... → empty → exit
```

不得使用 `Promise.all` 等并发方式处理多个 Job。Queue 按 at-least-once delivery 设计，必须考虑重复投递和网络重试；Job claim、结果写入、complete/fail 都需要幂等。

Job 至少需要 `queued`、`processing`、`completed`、`failed` 状态，并记录 worker_run、领取时间、完成时间、处理耗时和必要的重试信息。

## 10. R2

R2 保存原始图片和生成结果，避免大图片经过 Vercel API 中转。

关键决策：

- 提交阶段不生成处理 presigned URL。
- 点击开始处理后才生成。
- 临时 URL 有明确过期时间并覆盖预计处理窗口。
- Lightning 直接使用临时访问信息访问 R2。
- R2 长期 Secret 只存在 Vercel server-side。

## 11. 前端行为

### 提交任务

只负责把任务加入 Queue，不启动 Lightning，不生成处理 presigned URL。

### 开始处理

有 queued Job 且当前没有 active worker 时按钮可用。例如有 9 个 queued Job 就显示“开始处理（9 个任务）”。worker 已运行或没有 queued Job 时按钮灰色不可点击。前端根据历史 `processing_time_ms` 给出预计时间，仅用于 UI，不参与实际调度。

## 12. Neon 数据职责

至少记录：

- Job ID、尺寸和生成参数
- Job 状态
- 输入/输出 R2 object key
- processing time
- 错误信息
- worker_run/batch ID
- Worker Credential hash
- Credential expiry / revoked 状态
- Job claim/lease 信息

Credential 明文不得写入 Neon。

## 13. 核心文件

### Vercel 前端仓库

`jiojiojackson/id-photo-front`，开发分支 `agent/queue-job-architecture`。

- `app/page.tsx`：上传、尺寸、提交、开始处理、状态和结果。
- `app/api/jobs/submit/route.ts`：创建 Job 和 Queue 消息；不在提交阶段生成处理 URL。
- `app/api/jobs/start/route.ts`：创建 worker_run、生成 R2 临时访问信息和短期 Credential、调用 Lightning。
- `app/api/jobs/status/route.ts`：任务和 worker 状态。
- `app/api/worker/next/route.ts`：Queue Bridge 领取 Job。
- `app/api/worker/complete/route.ts`：成功回写。
- `app/api/worker/fail/route.ts`：失败回写。
- `lib/db.ts`：Neon/Postgres 连接。
- `lib/queue.ts`：Vercel server-side Queue SDK/API 封装。
- `lib/r2.ts`：R2 对象和 presigned URL。
- `DEV_STATE.md`：当前实际开发状态。
- `plan.md`：最终架构和实施计划。

### Lightning 后端仓库

`jiojiojackson/id-photo-back`。

- Docker inference API。
- `/generate` 等实际证件照推理 endpoint。
- 无状态 worker 消费逻辑。
- 从启动请求读取短期 Credential 和 Bridge URL。
- 严格串行处理 Job。
- Queue Bridge 返回 empty 后立即退出。
- 不直接使用 Vercel Queue SDK/API。
- 不保存长期 Vercel、Neon、R2 凭证。

## 14. 已验证与当前未完成

已验证：前端此前的 module alias、TypeScript reducer 隐式 any、Job `unit` 类型、R2 Web Crypto 类型等构建问题已处理；最近部署已进入 Next.js 页面数据收集阶段，当前已知失败点为 `lib/db.ts` 找不到 `DATABASE_URL`。Neon 已连接，但当前实际注入的数据库变量名称尚未确认，因此必须先确认实际变量名再修正 `lib/db.ts`。

尚未完成：确认实际 Neon 变量；完成 start → Bridge → Lightning 链路；实现短期 Credential；将 presigned URL 完全延迟到 start；实现 Queue claim/complete/fail 和幂等；完成 Lightning 无状态串行 worker；完成端到端测试。

## 15. 实施顺序

1. 确认 Vercel/Neon 实际数据库变量名称并修正 `lib/db.ts`。
2. 确认并修正提交阶段的 R2 URL 生成逻辑。
3. 实现 worker_run 和短期 Credential 数据模型。
4. 实现 `/api/jobs/start`。
5. 实现 Queue Bridge `next` / `complete` / `fail`。
6. 确保 Bridge 在 Vercel server-side 使用 Queue SDK。
7. 修改 Lightning 为无状态、串行 worker。
8. 实现重复领取、失败重试、幂等和异常退出处理。
9. 测试 3 Job、9 Job、重复提交、失败、重试、空队列和重复启动。
10. 最终验证 Vercel Build/Runtime、Lightning 推理和 R2/Neon 结果链路。

## 16. 明确废弃的方案

- Lightning 直接使用 `@vercel/queue` 和 Vercel Queue 内部认证：废弃。
- Lightning 保存 Vercel API Token/OIDC Token：废弃。
- Lightning 配置长期 `VERCEL_WORKER_SECRET`：废弃。
- Lightning 配置 `LIGHTNING_API_URL`：废弃；该 URL 由 Lightning 平台提供给 Vercel 使用。
- Lightning 配置 `LIGHTNING_API_KEY`：废弃；如平台要求，该 Key 只由 Vercel 保存并用于 Vercel → Lightning。
- 提交任务时生成 R2 presigned URL：废弃。
- 提交按钮直接启动 Lightning：废弃。
- Lightning 并发处理多个 Job：废弃。
- Queue empty 后固定等待 15 秒：废弃；现在明确为 empty 后立即退出。

## 17. 安全原则

任何密码、Token、API Key、私钥、Cookie、数据库密码等敏感信息不得写入 Git、`plan.md`、`DEV_STATE.md`、Queue payload 或日志。短期 Worker Credential 只用于本次 Lightning → Bridge 授权，浏览器永远不能读取；Vercel → Lightning 的认证信息只在 Vercel server-side 使用；Vercel Queue 内部认证只留在 Vercel 环境中。
