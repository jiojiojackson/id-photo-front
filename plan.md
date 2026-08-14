# AI 证件照 Vercel + Lightning 生产架构开发计划

## 1. 目标

构建一个“提交任务”和“开始处理”完全分离的证件照生成系统：前端负责创建 Job 并写入 Vercel Queue，用户确认后再点击开始处理；Vercel 负责唤醒 Lightning 推理 API；Lightning 从 Queue 串行消费 Job，逐个调用证件照推理接口并写回结果。Lightning 队列处理完成后立即结束运行，不等待新任务，以减少按 GPU/运行时间计费产生的空转。

## 2. 最终确认的职责划分

### Vercel / Next.js

- 提供移动端网页和登录后的任务管理界面。
- 用户选择一张原图并设置 3 个输出尺寸时，创建 3 个独立 Job，而不是一个包含 3 个尺寸的 Job。
- Job 状态保存在 Neon/Postgres，待处理任务进入 Vercel Queue。
- 页面持续读取 Queue/数据库状态，显示 queued、processing、completed、failed 等状态。
- 根据历史 `processing_time_ms` 计算平均处理时间，用于显示“开始处理（N 个任务）”和预计耗时；估算仅用于 UI，不作为调度依据。
- “提交任务”只负责创建 Job/进入队列，不唤醒 Lightning。
- 有 queued Job 且当前没有运行中的 worker 时，“开始处理”按钮可用；否则按钮显示不可用或当前处理状态。
- 用户点击“开始处理”后才生成需要的 R2 临时 URL，避免提交后等待过久导致 URL 过期。
- 生成临时 URL 后，通过 Lightning 平台 endpoint 调用 Lightning worker，并携带由 Lightning 平台提供、保存在 Vercel 环境变量中的认证信息。
- `LIGHTNING_API_KEY` 属于 Vercel 调用 Lightning 平台时使用的凭证；Lightning Docker 应用本身不自行设计或验证该 Key。

### Vercel Queue

使用以下配置：

- `VERCEL_QUEUE_NAME`
- `VERCEL_QUEUE_REGION`
- `VERCEL_QUEUE_CONSUMER_GROUP`

Consumer Group 必须实际用于 Queue consumer，保证 Lightning worker 按指定 consumer group 消费任务。

### Neon/Postgres

- 保存 Job 元数据、状态、尺寸、输入/输出对象信息、错误信息和处理时间等。
- 当前代码使用 `lib/db.ts` 初始化 Postgres 客户端。
- 必须以 Vercel/Neon Integration 当前实际提供的数据库环境变量为准，不能猜测变量名称；当前代码只读取 `DATABASE_URL`，这是下一步首先需要确认和修正的地方。

### Cloudflare R2

- 保存原始照片和生成结果。
- 使用 presigned URL 让 Lightning 访问/写入对象，避免把大文件直接经 Vercel 中转。
- 原图上传相关的临时 URL 不应在用户提交任务时长期生成；最终方案要求在点击“开始处理”后再生成，以减少过期风险。

### Lightning

- 运行 Docker 部署的 inference API。
- 只负责业务处理端点，例如 `/generate`，以及按最终方案提供给 Vercel 唤醒/消费的处理入口。
- 不实现自定义 `LIGHTNING_API_KEY` 认证。
- Lightning 平台负责为外部调用提供 endpoint 和认证 Key；Vercel 调用时携带该 Key。
- worker 必须严格串行处理 Job，不能并发推理。
- 每处理一个 Job 后继续检查 Queue；还有任务就继续处理下一个。
- Queue 为空时立即结束本次 worker，不等待 15 秒。最终方案已经从“空队列等待 15 秒后退出”调整为“处理完成后直接结束”，以进一步降低计费空转。

## 3. 最终任务流程

### A. 提交任务

1. 用户上传照片。
2. 前端设置 3 个尺寸以及 DPI、背景等参数。
3. 点击“提交任务（加入队列）”。
4. 前端为 3 个尺寸分别创建 Job，因此一次请求产生 3 个 Queue Job。
5. Job 保存到 Neon，并进入 Vercel Queue。
6. 不生成用于 Lightning 处理的长期临时 URL。
7. 不唤醒 Lightning。
8. 页面刷新队列数量并显示“开始处理（3 个任务）”。

### B. 开始处理

1. 用户点击“开始处理（N 个任务）”。
2. Vercel 再次确认队列中存在 queued Job，并确认没有正在运行的 worker。
3. Vercel 为本批待处理 Job 生成所需的 R2 presigned URL，并确保有效期覆盖本次处理。
4. Vercel 调用 Lightning endpoint，并携带 `LIGHTNING_API_KEY`。
5. Lightning worker 启动后使用配置的 Queue name、region 和 consumer group 消费 Job。
6. worker 一次只取得并处理一个 Job。
7. Job 状态更新为 processing。
8. Lightning 调用自己的证件照 `/generate` 推理接口。
9. 生成结果写入 R2。
10. Job 更新为 completed，并记录处理耗时和结果对象信息；失败则更新为 failed 并记录错误。
11. worker 继续处理下一个 Job。
12. Queue 为空后立即退出 worker。
13. 前端轮询状态并展示最终结果。

## 4. 并发与计费策略

核心原则是 Lightning 绝不并发处理 Job。一次只运行一个推理任务，避免 GPU 显存竞争、资源浪费以及推理服务同时处理多个任务造成的不确定性。worker 不在空队列状态保持运行，也不等待新的 Job；用户需要处理新一批任务时，再通过“开始处理”重新唤醒 Lightning。

## 5. 当前核心文件

前端仓库 `jiojiojackson/id-photo-front` 当前开发分支：`agent/queue-job-architecture`。

- `app/page.tsx`：上传、尺寸设置、提交任务、开始处理、状态展示和结果展示。
- `app/api/jobs/submit/route.ts`：创建 Job 并进入 Queue 的入口；目前仍需调整 R2 URL 生成时机。
- `app/api/jobs/start/route.ts`：开始处理入口；目前需要核查其 Lightning bridge/worker URL 是否与实际实现一致。
- `app/api/jobs/status/route.ts`：任务和 worker 状态查询。
- `lib/db.ts`：Neon/Postgres 连接，目前只读取 `DATABASE_URL`，需要根据实际 Vercel/Neon Integration 变量确认后调整。
- `lib/queue.ts`：Vercel Queue client，使用 name、region 和 consumer group。
- `lib/r2.ts`：R2 presigned URL 工具，已处理新版 TypeScript/Web Crypto 的 BufferSource 类型问题。
- `DEV_STATE.md`：当前已确认开发状态和下一步任务。

后端仓库 `jiojiojackson/id-photo-back`：

- Docker 部署的 Lightning inference API。
- 业务核心端点为 `/generate`，并需要按照本计划实现/确认 Queue 串行消费入口。
- 后端不自行配置或验证 `LIGHTNING_API_KEY`。

## 6. 已验证内容

截至当前开发状态，Vercel 最近一次失败部署已经确认：代码能够通过编译和 TypeScript 检查；此前的 `@/lib/*` alias、`reduce` 隐式 any、`Job.unit` 类型以及 R2 Web Crypto BufferSource 类型错误均已处理。当前最新已知失败发生在 Next.js 页面数据收集阶段，错误为 `DATABASE_URL is not configured`。因此当前代码尚未完成生产环境端到端验证。

## 7. 当前未完成项

1. 确认 Vercel/Neon Integration 实际注入的数据库环境变量名称，并让 `lib/db.ts` 使用实际可用变量；不得把变量名称当作猜测。
2. 修正提交流程，使 presigned URL 的生成严格发生在“开始处理”之后。
3. 核查 `app/api/jobs/start/route.ts` 当前使用的 `/api/worker` bridge 是否真实存在，并与 Lightning endpoint 的实际路径协调一致。
4. 确认 Lightning worker 能够通过 Queue consumer group 获取 Job，并严格串行处理。
5. 确认每个 Job 的原图访问、推理、R2 结果写入、Neon 状态更新完整闭环。
6. 验证失败 Job 的状态、错误信息和后续任务是否仍能继续处理。
7. 验证 Queue 为空时 Lightning 是否立即退出。
8. 完成真实的 3 Job 端到端测试，以及重复提交、失败、空队列和结果下载测试。
9. 最后重新检查 Vercel Build Log 和运行时日志，确认生产环境稳定运行。

## 8. 已废弃/修正的方案

- 不在 Lightning Docker 内人为配置 `LIGHTNING_API_KEY`；认证属于 Lightning 平台对外 endpoint 的机制。
- 不让 Lightning 在 Queue 为空后继续运行并等待 15 秒；最终方案改为 Queue 为空立即退出。
- 不在用户提交任务时提前生成可能长期闲置的 presigned URL；最终方案要求点击开始处理后再生成。
- 不使用并发 worker 推理；最终方案固定为单 worker、单 Job 串行处理。
- 不需要依赖未确认存在的 `/api/worker` 路由；开始处理链路必须最终与实际存在的 Lightning endpoint/bridge 实现一致。
