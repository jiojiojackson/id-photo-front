# AI 证件照 Vercel + Lightning 生产架构开发计划

## 1. 目标

构建一个“提交任务”和“开始处理”完全分离的证件照生成系统：前端先把一次请求的多个尺寸拆成独立 Job 写入 Vercel Queue；用户确认后点击“开始处理”；Vercel 在开始阶段生成本批任务所需的 R2 临时访问信息并唤醒 Lightning；Lightning 严格串行处理 Job，队列为空后立即结束，以尽量减少按 GPU/运行时间计费产生的空转。

## 2. 最终确认的关键架构决策

### 2.1 不让 Lightning 直接持有 Vercel Queue 的内部认证凭证

已根据 Vercel Queues 当前 SDK/平台行为重新确认：Vercel Queue 的 SDK 在 Vercel 运行环境中依赖平台提供的认证/OIDC 上下文；官方 Queue consumer 也是由 Vercel Queue 基础设施调用的。公开资料还显示，Vercel Queues 当前并不适合作为两个独立应用之间直接共享消费凭证的通用消息总线，存在 OIDC token application scoping 的限制。citeturn0search5turn0search6

因此最终方案**不采用**“把 Vercel Queue 内部凭证直接传给 Lightning，再让 Lightning 在 Vercel 外部调用 Queue SDK/API”的设计。这样可以避免把 Vercel 项目的平台级凭证暴露给外部 GPU 服务，也避免依赖未确认支持的跨应用 Queue 认证方式。

### 2.2 Lightning 通过 Vercel Queue Bridge 消费任务

最终采用“Vercel Queue Bridge”方案：

```text
用户
 │
 ▼
Vercel / Next.js
 │
 ├─ Queue 中已有 9 个 Job
 │
 └─ 点击「开始处理」
       │
       ├─ 生成 R2 presigned URL
       │
       └─ 调用 Lightning
              │
              └─ Lightning 带专用 Worker Token 调用 Vercel Bridge
                         │
                         ▼
                  Vercel Queue Bridge
                         │
                         ├─ 使用 Vercel 环境内的 Queue SDK
                         ├─ 从 Queue 取得 1 个 Job
                         ├─ 返回 Job 给 Lightning
                         └─ 接收 Job 完成/失败确认并更新状态
                                  │
                                  ▼
                              Lightning
                         ├─ 处理 1 个 Job
                         ├─ 再请求下一个 Job
                         └─ Queue 空 → 退出
```

Lightning 不需要知道 Vercel Queue 的底层认证/OIDC，也不直接连接 Queue。它只访问 Vercel 暴露的、专门给 worker 使用的内部 API。

### 2.3 Lightning → Vercel Bridge 的认证方式

新增一个**专用的随机 Worker Secret**，例如环境变量名最终确定为：

- Vercel：`LIGHTNING_WORKER_SECRET`
- Lightning：`VERCEL_WORKER_SECRET`

两边保存同一个随机高熵 Secret，但 Secret 不写入 Git、不写入 Queue Job、不暴露给浏览器、不记录日志。

Lightning 调用 Bridge 时通过服务器端 HTTP Header 发送该 Secret，例如使用 `Authorization: Bearer <worker-secret>`。Vercel Bridge 只接受服务端请求，并在进入 Queue SDK 前验证该 Secret。

这个 Secret 只是“Lightning 是否有权限调用本项目的 Queue Bridge”的应用级共享密钥，不是 Vercel API Token、Vercel OIDC Token，也不是 Vercel Queue 的内部认证凭证。这样 Lightning 只获得访问本项目特定 Bridge 的最小权限。

如未来需要更强的安全性，可以进一步改为短期签名 token；当前第一版使用高熵 Worker Secret，简单且适合本项目。

## 3. 职责划分

### Vercel / Next.js

- 提供移动端网页和登录后的任务管理界面。
- 用户一次设置 3 个输出尺寸时，创建 3 个独立 Job。
- Job 元数据和状态保存到 Neon/Postgres。
- Job 写入 Vercel Queue。
- 页面显示 queued、processing、completed、failed 等状态。
- 根据历史 `processing_time_ms` 估算本批处理时间；估算只用于 UI，不参与调度。
- “提交任务”只创建 Job 和进入 Queue，不唤醒 Lightning。
- 有 queued Job 且没有运行中的 worker 时，“开始处理”按钮可用；否则按钮不可用或显示当前状态。
- 用户点击“开始处理”后才生成本批任务所需的 R2 presigned URL。
- 调用 Lightning 平台 endpoint，并使用 Lightning 平台提供的 `LIGHTNING_API_KEY`。
- 提供 Queue Bridge API 给 Lightning worker 使用；Bridge 在 Vercel 运行环境内使用官方 Queue SDK，因此 Queue 的平台认证不会离开 Vercel。
- Bridge 负责安全地向 Lightning 提供 Job，并接收处理结果/状态确认。

### Vercel Queue

使用并保留以下项目配置：

- `VERCEL_QUEUE_NAME`
- `VERCEL_QUEUE_REGION`
- `VERCEL_QUEUE_CONSUMER_GROUP`

这些变量用于 Vercel 内部 Queue SDK/consumer 配置。它们不是给 Lightning 直接连接 Queue 的凭证。

### Queue Bridge

建议新增独立的服务器端 API，例如：

- `POST /api/worker/next`：Lightning 请求领取下一个 queued Job。
- `POST /api/worker/complete`：Lightning 报告 Job 成功并提交结果对象信息。
- `POST /api/worker/fail`：Lightning 报告 Job 失败并提交错误信息。
- 可选 `POST /api/worker/heartbeat`：仅在确有必要时用于记录 worker 活跃状态；第一版可以不实现。

所有 Bridge endpoint 都验证 `LIGHTNING_WORKER_SECRET`，并且绝不把该 Secret 返回给客户端。

Bridge 内部才调用 Vercel Queue SDK；Lightning 不安装或调用 `@vercel/queue` 来直接访问 Queue。

### Neon/Postgres

- 保存 Job 元数据、状态、尺寸、输入/输出对象信息、错误信息和处理时间等。
- `lib/db.ts` 必须使用 Vercel/Neon Integration 当前实际提供的数据库环境变量；不能猜测变量名称。
- 数据库是任务状态的持久化真相源；Queue 负责任务传递，不能仅依赖 Queue 状态作为最终结果记录。

### Cloudflare R2

- 保存原始照片和生成结果。
- Lightning 通过 presigned URL 访问输入并写入结果，避免大文件经 Vercel 中转。
- 与处理相关的 presigned URL 严格在点击“开始处理”后生成，以降低 URL 在排队期间过期的风险。

### Lightning

- 运行 Docker 部署的 inference API。
- 业务推理端点例如 `/generate`，由 Lightning 应用自身负责实际图片处理。
- 不自行实现或人为配置 `LIGHTNING_API_KEY`；该 Key 由 Lightning 平台提供，Vercel 使用它调用 Lightning endpoint。
- Lightning Docker worker 不直接连接 Vercel Queue。
- Lightning worker 使用 `VERCEL_WORKER_SECRET` 调用 Vercel Queue Bridge。
- 严格一次只处理一个 Job，不并发推理。
- 一个 Job 完成后，再向 Bridge 请求下一个 Job。
- Bridge 返回没有 Job 后，Lightning 立即结束本次运行，不等待新的任务。

## 4. 最终任务流程

### A. 提交任务

1. 用户上传照片。
2. 设置 3 个尺寸以及 DPI、背景等参数。
3. 点击“提交任务（加入队列）”。
4. 前端为 3 个尺寸分别创建 Job，因此一次请求产生 3 个 Queue Job。
5. Job 元数据写入 Neon，并进入 Vercel Queue。
6. 不生成用于 Lightning 处理的 presigned URL。
7. 不唤醒 Lightning。
8. 页面显示例如“开始处理（3 个任务）”。

### B. 开始处理

1. 用户点击“开始处理（N 个任务）”。
2. Vercel 确认存在 queued Job，并确认当前没有运行中的 worker。
3. Vercel 为本批待处理 Job 准备 R2 presigned URL，并确保有效期覆盖处理过程。
4. Vercel 调用 Lightning 平台 endpoint，并携带 `LIGHTNING_API_KEY`。
5. Lightning 启动后，不直接访问 Queue，而是调用 Vercel Queue Bridge，并使用 `VERCEL_WORKER_SECRET`。
6. Bridge 在 Vercel 环境内使用 Queue SDK 获取一个 Job，并同时从 Neon 确认/更新其 processing 状态。
7. Lightning 一次只处理这个 Job。
8. Lightning 调用自己的 `/generate` 推理接口。
9. 结果写入 R2。
10. Lightning 调用 Bridge 的 complete endpoint，Bridge 更新 Neon Job 为 completed 并记录处理耗时和结果对象信息；失败则调用 fail endpoint。
11. Lightning 再调用 Bridge 获取下一个 Job。
12. 重复上述过程直到 Bridge 返回“没有可处理 Job”。
13. Lightning 立即退出。
14. 前端继续轮询状态并展示结果。

## 5. 并发、幂等和计费策略

- Lightning 固定单 worker、单 Job 串行处理。
- Bridge 必须避免同一个 Job 被两个 worker 同时领取；领取 Job 时需要使用数据库事务/原子状态更新或 Queue consumer group 的可靠消费语义实现互斥。
- Vercel Queue 当前采用 at-least-once delivery 语义，因此不能假设消息绝不会重复；Job 状态更新和结果写入必须具备幂等保护。citeturn0search7
- Lightning 不保持空闲 worker；Bridge 返回空队列后立即退出。
- 用户新建任务后需要再次点击“开始处理”才能唤醒 Lightning。

## 6. 环境变量设计

### Vercel

```text
VERCEL_QUEUE_NAME
VERCEL_QUEUE_REGION
VERCEL_QUEUE_CONSUMER_GROUP

LIGHTNING_API_URL
LIGHTNING_API_KEY

LIGHTNING_WORKER_SECRET

<实际 Neon/Vercel Integration 提供的数据库连接变量>

<R2 相关变量>
```

其中 `LIGHTNING_WORKER_SECRET` 是 Vercel Bridge 验证 Lightning worker 的共享 Secret；不要与 `LIGHTNING_API_KEY` 混淆。

### Lightning Docker

```text
LIGHTNING_API_URL / 实际推理端点配置（如部署需要）
VERCEL_WORKER_SECRET
Vercel Bridge URL
R2 处理所需的运行时配置（按最终 R2 访问方式确定）
```

Lightning 不配置 `LIGHTNING_API_KEY` 作为自己对外认证的实现；该 Key 属于 Vercel → Lightning 平台调用方向。

## 7. 当前核心文件与预计调整

前端仓库 `jiojiojackson/id-photo-front`，开发分支：`agent/queue-job-architecture`。

- `app/page.tsx`：上传、尺寸设置、提交、开始处理、状态和结果展示。
- `app/api/jobs/submit/route.ts`：创建 3 个 Job 并进入 Queue；需要移除提交阶段的 presigned URL 生成。
- `app/api/jobs/start/route.ts`：开始处理入口；负责生成/准备 R2 URL、启动 Lightning，并建立本次 worker 运行状态。
- `app/api/jobs/status/route.ts`：任务状态和 worker 状态查询。
- `app/api/worker/next/route.ts`：新增/调整的 Queue Bridge，Lightning 从这里领取 Job。
- `app/api/worker/complete/route.ts`：新增/调整的完成回写 Bridge。
- `app/api/worker/fail/route.ts`：新增/调整的失败回写 Bridge。
- `lib/db.ts`：Neon/Postgres 连接，需要先根据实际 Integration 变量修正。
- `lib/queue.ts`：只在 Vercel 服务端使用 Queue SDK，不让 Lightning 直接使用。
- `lib/r2.ts`：R2 presigned URL 工具。
- `DEV_STATE.md`：记录实际开发状态。
- `plan.md`：记录最终架构和实施顺序。

后端仓库 `jiojiojackson/id-photo-back`：

- Docker 部署的 Lightning inference API。
- `/generate` 等业务端点继续负责图片推理。
- worker 消费入口改为调用 Vercel Queue Bridge，而不是直接调用 Vercel Queue SDK/API。
- worker 必须串行执行 Job。
- worker 需要在每次处理后重新向 Bridge 请求 Job，直到 Bridge 返回空队列。

## 8. 已验证与当前状态

已确认 Vercel 最近的代码构建阶段已经能够通过编译和 TypeScript 检查；此前的 `@/lib/*` alias、`reduce` 隐式 any、`Job.unit` 类型和 R2 Web Crypto BufferSource 类型问题均已处理。当前生产部署曾在 Next.js 页面数据收集阶段因为 `lib/db.ts` 找不到 `DATABASE_URL` 而失败；Neon Integration 已连接，但当前代码与实际注入变量名称尚未完成确认，因此数据库连接仍是下一步首要任务。

Vercel Queues 的官方/公开资料确认其 SDK 和 consumer 依赖 Vercel 平台运行环境；同时已有公开反馈指出跨独立应用直接消费存在 OIDC application-scoping 限制。因此本计划已明确放弃“Lightning 直接拿 Vercel Queue 内部凭证消费 Queue”的方案，改用 Vercel 内部 Queue Bridge。citeturn0search5turn0search6

## 9. 当前未完成项及实施顺序

1. 确认 Vercel/Neon Integration 实际数据库环境变量名称并修正 `lib/db.ts`。
2. 修改提交接口，确保提交时只创建 Job，不生成处理用 presigned URL。
3. 在开始处理接口生成本批 R2 presigned URL。
4. 实现/确认 Queue Bridge，并让所有 Queue SDK 调用只发生在 Vercel 环境。
5. 实现 `LIGHTNING_WORKER_SECRET` / `VERCEL_WORKER_SECRET` 的服务器端认证。
6. 调整 Lightning Docker worker：调用 Bridge、单 Job 串行处理、完成/失败回写、空队列立即退出。
7. 实现 Job 领取的互斥和幂等保护，避免重复消费或重复生成结果。
8. 完成单次 3 Job、多个用户/批次、重复请求、失败 Job、空队列和结果下载的端到端测试。
9. 检查 Vercel Build、Runtime Logs、Queue consumer 状态以及 Lightning 日志。
10. 通过完整测试后再合并开发分支。

## 10. 已废弃/修正的方案

- 不在 Lightning Docker 中人为配置或验证 `LIGHTNING_API_KEY`；该 Key 属于 Lightning 平台提供给 Vercel 的外部调用认证。
- 不把 Vercel Queue 内部 OIDC/API 凭证直接传给 Lightning。
- 不让 Lightning 直接调用 `@vercel/queue` 访问 Vercel Queue。
- 不在用户提交任务时提前生成处理用 presigned URL。
- 不让 Lightning 在空队列后等待 15 秒；最终要求是空队列立即退出。
- 不使用并发 Lightning worker 推理；固定为单 Job 串行处理。
- 不依赖尚未确认存在的 `/api/worker` 单一路由；最终应明确拆分/实现 Queue Bridge endpoint，并与 Lightning worker 的实际调用路径一致。
