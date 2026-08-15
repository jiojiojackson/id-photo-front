# AI 证件照 Vercel + Lightning 最终开发方案

## 1. 目标

构建一个“提交任务”和“开始处理”完全分离的生产任务系统。用户先上传照片并设置多个尺寸；一次输入 3 个尺寸就创建 3 个独立 Job，Job 进入 Vercel Queue，但此时不启动 Lightning，也不生成处理用的 R2 presigned URL。用户点击“开始处理”后，Vercel 为本批任务准备临时 R2 访问信息，生成一次性的短期 Worker Credential，并在唤醒 Lightning 时把本次运行所需的信息传给 Lightning。Lightning 作为无状态、无持久化环境变量的 Docker worker，严格串行处理 Job；每个 Job 完成后继续取下一个，Queue 没有 Job 时立即结束本次运行，以尽可能减少 Lightning 按运行时间/GPU 时间产生的费用。

## 2. 最终确认的架构

```text
用户
  │
  ▼
Vercel / Next.js
  │
  ├── 提交任务：创建 Job × N → Neon + Vercel Queue
  │
  └── 点击“开始处理”
        │
        ├── 检查 queued Job / worker 状态
        ├── 生成本批处理所需的 R2 presigned URL
        ├── 生成短期 Worker Credential（例如有效期 3 小时）
        └── 调用 Lightning 平台提供的公网 inference endpoint
              │
              │ 本次启动请求携带：
              │ - 短期 Worker Credential
              │ - Vercel Queue Bridge URL
              │ - 本次运行必要的非敏感参数
              ▼
        Lightning 无状态 Docker Worker
              │
              ├── 内存中保存本次启动收到的短期 Credential
              ├── POST /api/worker/next
              │       │
              │       ▼
              │   Vercel Queue Bridge
              │       │
              │       └── Vercel 环境内使用 @vercel/queue
              │
              ├── 严格处理 1 个 Job
              ├── 调用自己的 /generate 推理端点
              ├── 使用 R2 临时访问信息读写图片
              ├── POST /api/worker/complete 或 /fail
              ├── 再 POST /api/worker/next
              └── Bridge 返回空队列 → Lightning 立即退出
```

核心原则：**Lightning 不直接连接 Vercel Queue，不保存 Vercel Queue 内部凭证，不保存长期 Secret，不需要为 Queue 配置环境变量。** Vercel Queue 的 SDK/API 认证和平台上下文只存在于 Vercel 的服务器端 Bridge 中。

## 3. Lightning 的最终设计：无状态容器

Lightning Docker 容器按无状态 worker 设计：

- 不人为配置 `LIGHTNING_API_KEY`。
- 不配置 `VERCEL_QUEUE_NAME`、`VERCEL_QUEUE_REGION`、`VERCEL_QUEUE_CONSUMER_GROUP`。
- 不保存 Vercel Queue 的长期认证凭证。
- 不保存本项目的长期 Worker Secret。
- 不要求 Lightning 直接安装或使用 `@vercel/queue`。
- Lightning 平台负责提供其公网 inference API URL；项目不在 Lightning Docker 容器内部人为配置一个 `LIGHTNING_API_URL`。
- Lightning 每次被唤醒时，从本次启动请求获得 Queue Bridge URL 和短期 Worker Credential，并且只在当前进程内存中使用它们。
- 本次运行结束后，容器可以直接退出；Credential 即使仍在有效期内，也不会被持久化到容器磁盘或环境变量。

这里必须区分两个方向：Lightning 平台提供的公网 inference API 是 **Vercel → Lightning** 的调用目标；Queue Bridge 是 **Lightning → Vercel** 的调用目标。两者不能混淆。

## 4. Lightning → Vercel Bridge 的短期凭证方案

不使用长期 `LIGHTNING_WORKER_SECRET` 环境变量。改为在用户点击“开始处理”时，由 Vercel 动态生成一个高熵随机短期 Credential。

推荐第一版实现：

1. Vercel 使用密码学安全随机数生成一次短期随机 Credential。
2. Vercel 只把 Credential 的哈希值保存到 Neon，不保存明文。
3. Credential 与本次 worker run/batch 绑定，并设置明确的过期时间，默认建议 3 小时；实际实现可统一使用一个配置常量。
4. Credential 至少绑定以下范围：本项目、当前处理批次、允许访问的 Queue Bridge，以及过期时间。
5. Vercel 调用 Lightning 时，在服务器端请求 body 中把明文短期 Credential 和 Queue Bridge URL 一起传给 Lightning。
6. Lightning 只在当前进程内存中保存 Credential，并在请求 Bridge 时通过 `Authorization: Bearer <credential>` 发送。
7. Bridge 收到请求后计算 Credential 哈希，与 Neon 中未过期、未撤销、属于当前 worker run 的记录进行比对。
8. 验证成功后才允许访问 `/api/worker/next`、`/complete`、`/fail`。
9. Credential 到期后自动失效；worker run 结束时 Vercel 可以立即将其标记为 revoked/completed，使其即使尚未到 3 小时也不能继续消费。
10. Credential 不进入 Queue Job payload、不返回给浏览器、不写入日志、不写入 R2、不写入 Git。

选择这种方式的原因是：Lightning 不需要任何长期环境变量或平台级 Vercel Token；短期 Credential 只在一次 worker 启动时传入，且 Bridge 在 Vercel 内部继续使用 Vercel Queue SDK。Lightning 即使被复制或重启，也不会获得长期访问能力。

### 关于“几小时短期凭证”

有效期建议默认 3 小时，而不是永久 Secret。证件照任务通常应在一次 worker 运行内完成；3 小时主要用于防止异常慢任务或网络重试导致 Credential 过早失效。实际超时应由 worker run 的状态和 Job 状态共同控制。若 Queue 已为空，立即撤销 Credential；若发生异常退出，也应由 Vercel 的过期机制兜底。

## 5. Vercel Queue 的认证边界

Vercel Queues 的官方 SDK/consumer 依赖 Vercel 运行环境提供的认证/平台上下文；公开资料也存在跨独立应用直接消费时受到 OIDC application scoping 限制的情况。因此最终方案不让外部 Lightning 直接持有 Vercel Queue 内部认证凭证。

Vercel Queue 的真正消费者是 Vercel 内部的 Queue Bridge：

- Bridge 在 Vercel server-side runtime 中运行。
- Bridge 内部调用官方 `@vercel/queue` SDK。
- Queue 的内部认证/OIDC 不离开 Vercel。
- Lightning 只调用普通 HTTPS Bridge API。
- Bridge 用短期 Credential 判断 Lightning 是否有权进行本次 worker run 的操作。

因此 Lightning 不需要知道 Queue SDK 的认证细节。

## 6. Vercel 环境变量/配置

Vercel 侧保留 Queue 配置：

- `VERCEL_QUEUE_NAME`
- `VERCEL_QUEUE_REGION`
- `VERCEL_QUEUE_CONSUMER_GROUP`

它们只供 Vercel server-side Queue 逻辑使用，不发送给浏览器，也不要求 Lightning 配置。

Vercel 还需要保存：

- Lightning 平台提供的调用认证信息（当前项目约定为 `LIGHTNING_API_KEY`，仅供 Vercel → Lightning 使用）。
- R2 相关服务端凭证。
- Neon/Vercel Integration 实际提供的数据库连接变量；不得猜测变量名。
- Queue Bridge 使用的数据库/业务配置。

短期 Worker Credential **不是预先配置的环境变量**，而是在点击“开始处理”时动态生成。

## 7. Lightning 侧配置边界

最终原则：Lightning Docker 应尽可能成为无状态容器。

Lightning 不需要人为配置：

- `LIGHTNING_API_KEY`
- `VERCEL_QUEUE_NAME`
- `VERCEL_QUEUE_REGION`
- `VERCEL_QUEUE_CONSUMER_GROUP`
- 长期 `VERCEL_WORKER_SECRET`
- 长期 Queue API Token

Lightning 需要的本次运行参数由 Vercel 在启动请求中传入：

- Queue Bridge URL
- 短期 Worker Credential
- 本次运行所需的 R2 临时访问信息/Job 访问信息
- 其他非敏感的运行参数

这些参数只存在于本次 worker 进程的内存生命周期中。

## 8. 提交任务流程

1. 用户上传原始照片。
2. 用户设置 3 个尺寸、DPI、背景等参数。
3. 点击“提交任务（加入队列）”。
4. Vercel 创建 3 个独立 Job。
5. Job 元数据写入 Neon。
6. Job 消息进入 Vercel Queue。
7. 此阶段不启动 Lightning。
8. 此阶段不生成处理用 R2 presigned URL，避免用户等待期间 URL 过期。
9. 前端检测 queued 数量并显示“开始处理（3 个任务）”。

## 9. 开始处理流程

1. 用户点击“开始处理（N 个任务）”。
2. Vercel 再次确认存在 queued Job，并确认当前没有 active worker run。
3. Vercel 创建一个 worker run/batch 记录。
4. Vercel 为本批待处理 Job 准备 R2 presigned URL；URL 的有效期必须覆盖预计处理时间，并保留重试余量。
5. Vercel 生成短期 Worker Credential，默认有效期 3 小时，并只保存其哈希。
6. Vercel 调用 Lightning 平台公网 inference endpoint。
7. 启动请求携带本次运行所需的 Bridge URL、短期 Credential、批次标识以及必要的 R2/Job 访问信息。
8. Lightning 启动后将 Credential 保存在内存。
9. Lightning 调用 `/api/worker/next`。
10. Bridge 验证短期 Credential，并在 Vercel 环境内从 Queue 获取一个 Job。
11. Bridge 返回一个 Job 及本次 Job 所需的临时访问信息。
12. Lightning 严格只处理这个 Job，不启动并发任务。
13. Lightning 调用自己的 `/generate` 推理接口。
14. 生成结果写入 R2。
15. Lightning 调用 `/api/worker/complete` 回写成功状态和结果信息；失败则调用 `/api/worker/fail`。
16. Lightning 再次调用 `/api/worker/next`。
17. 重复处理直到 Bridge 明确返回没有可处理 Job。
18. Lightning 立即结束进程，不等待新任务。
19. Vercel 将 worker run 标记完成，并撤销本次 Credential。
20. 前端继续轮询状态并显示结果。

## 10. Queue Bridge API

建议提供：

### `POST /api/worker/next`

用途：Lightning 领取下一个 Job。

Bridge 必须：

- 验证短期 Worker Credential。
- 验证 Credential 未过期、未撤销且属于当前 worker run。
- 从 Vercel Queue 获取一个 Job。
- 与 Neon Job 状态保持一致。
- 防止同一 Job 被两个 worker 同时处理。
- 返回输入/输出所需的临时访问信息。
- Queue 为空时返回明确的 `empty` 状态，而不是让 Lightning 长时间等待。

### `POST /api/worker/complete`

用途：Lightning 报告 Job 成功。

Bridge 必须：

- 验证短期 Credential。
- 验证 Job 属于当前 worker run。
- 以幂等方式更新 Neon。
- 记录结果对象、处理时间等信息。
- 完成 Queue 消息确认/删除所需的操作。

### `POST /api/worker/fail`

用途：Lightning 报告 Job 失败。

Bridge 必须：

- 验证短期 Credential。
- 记录错误。
- 按最终重试策略决定 Job 是重新入队、失败还是结束。
- 保证重复 fail 请求不会破坏状态。

## 11. 串行和可靠性要求

Lightning 永远一次只处理一个 Job：

```text
next
 ↓
process 1
 ↓
complete/fail
 ↓
next
 ↓
process 2
 ↓
...
 ↓
empty
 ↓
exit
```

不得使用 `Promise.all` 或其他并发方式同时处理多个图片。

Vercel Queue 应按 at-least-once delivery 设计，因此不能假设消息绝不重复。Neon Job 状态、结果写入和 Queue 确认必须具有幂等性。

建议 Job 至少具有：

- `queued`
- `processing`
- `completed`
- `failed`

以及 worker run/batch 标识、领取时间、完成时间、处理耗时、重试次数等字段。

## 12. R2 设计

R2 用于保存原始图片和生成结果，避免大图片通过 Vercel API 中转。

关键决策：

- 提交阶段不生成处理用 presigned URL。
- 点击开始处理后才生成。
- URL 必须覆盖整个处理批次的预计时间并留有余量。
- Lightning 直接访问 R2，不通过 Vercel 转发图片数据。
- URL 和对象 key 不作为长期凭证保存。

## 13. 前端行为

前端任务按钮分为两个完全独立的动作：

### 提交任务

- 将任务加入 Queue。
- 不启动 Lightning。
- 不生成处理 presigned URL。

### 开始处理

- 只有存在 queued Job 且当前没有 active worker 时可点击。
- 如果 Queue 有 9 个 Job，按钮显示“开始处理（9 个任务）”。
- 如果已经有 worker 运行，按钮灰色不可点击。
- 根据历史 `processing_time_ms` 给出预计处理时间；估算只用于 UI，不作为实际超时依据。
- 点击后才触发 R2 URL 准备、短期 Credential 创建和 Lightning 唤醒。

## 14. 核心文件

### 前端仓库

`jiojiojackson/id-photo-front`，开发分支：`agent/queue-job-architecture`

- `app/page.tsx`：上传、尺寸、提交、开始处理、任务状态和结果。
- `app/api/jobs/submit/route.ts`：创建 Job 并进入 Queue；不能在提交阶段生成处理 presigned URL。
- `app/api/jobs/start/route.ts`：创建 worker run、生成 R2 临时访问信息和短期 Credential，并唤醒 Lightning。
- `app/api/jobs/status/route.ts`：任务和 worker 状态查询。
- `app/api/worker/next/route.ts`：Queue Bridge 领取 Job。
- `app/api/worker/complete/route.ts`：Queue Bridge 完成回写。
- `app/api/worker/fail/route.ts`：Queue Bridge 失败回写。
- `lib/db.ts`：Neon/Postgres 连接，必须匹配实际 Vercel/Neon Integration 变量。
- `lib/queue.ts`：只在 Vercel server-side 使用 Queue SDK。
- `lib/r2.ts`：R2 presigned URL 和对象操作。
- `DEV_STATE.md`：当前真实开发状态。
- `plan.md`：最终架构和实施计划。

### 后端仓库

`jiojiojackson/id-photo-back`

- Docker 部署的 Lightning inference API。
- `/generate` 等业务端点负责实际证件照推理。
- 增加/调整 worker 消费逻辑，使其调用 Vercel Queue Bridge。
- 不直接使用 Vercel Queue SDK/API。
- 不保存长期 Vercel 凭证。
- 从启动请求读取短期 Credential 和 Bridge URL。
- 严格串行处理 Job。
- Queue Bridge 返回 empty 后立即退出。

## 15. 已验证和当前已知问题

已经验证 Vercel 前端代码曾经通过编译和 TypeScript 检查；此前的路径 alias、TypeScript reducer 隐式 any、Job 类型缺少 `unit`、R2 Web Crypto BufferSource 类型等构建问题已经处理。

当前已知的部署问题是 `lib/db.ts` 在 Next.js 页面数据收集阶段报告没有找到 `DATABASE_URL`。Neon Integration 已连接，但尚未确认当前项目实际注入的数据库变量名称，因此不能假设使用 `DATABASE_URL`、`POSTGRES_URL` 或其他变量；下一步应先确认实际变量名，再修正数据库连接。

当前代码与本最终方案之间还需要继续检查和调整：提交接口仍需确认/移除提交阶段的 presigned URL；start/worker Bridge 链路需要完成；Lightning 后端需要按无状态 worker 重构；短期 Credential、worker run、Queue claim/complete/fail 的数据库状态模型需要实现；整个 Queue → Lightning → R2 → Neon 流程尚未完成端到端验证。

## 16. 实施顺序

1. 确认 Vercel/Neon Integration 实际数据库环境变量名称并修正 `lib/db.ts`。
2. 检查并修正提交阶段的 R2 presigned URL 生成逻辑，确保提交时不生成处理 URL。
3. 设计 Neon 中 worker run 与短期 Credential 的数据模型，包括 hash、expiry、revoked、batch scope 等字段。
4. 实现 `/api/jobs/start`：生成 worker run、R2 临时访问信息和短期 Credential，并调用 Lightning。
5. 实现 Queue Bridge：`next`、`complete`、`fail`。
6. 确保 Bridge 在 Vercel server-side runtime 使用官方 Queue SDK，并正确处理 Queue consumer/ack 语义。
7. 修改 Lightning 后端为无状态串行 worker：启动参数 → 内存 Credential → next → generate → R2 → complete/fail → next → empty → exit。
8. 完成重复领取、失败重试、幂等和异常退出处理。
9. 完成单次 3 Job、9 Job、重复提交、失败 Job、Queue 空、worker 重复启动等测试。
10. 最后进行 Vercel Build、Runtime Log 和 Lightning 实际推理的端到端验证。

## 17. 明确废弃的方案

- Lightning 直接安装 `@vercel/queue` 并使用 Vercel Queue 内部认证消费 Queue：废弃。
- 把 Vercel API Token/OIDC Token 长期放进 Lightning：废弃。
- 在 Lightning Docker 中配置长期 `VERCEL_WORKER_SECRET`：废弃。
- 提交任务时立即生成 R2 presigned URL：废弃。
- 提交任务按钮直接启动 Lightning：废弃。
- Lightning 并发处理多个 Job：废弃。
- Lightning 队列为空后继续等待 15 秒：最终方案废弃；现在明确为 Queue Bridge 返回 empty 后立即结束，以最大限度减少计费时间。

## 18. 安全原则

任何密码、Token、API Key、私钥、Cookie、数据库密码等敏感信息都不得写入 Git、`plan.md`、`DEV_STATE.md`、Queue payload 或日志。

短期 Worker Credential 只用于 Lightning → Queue Bridge 的本次运行授权；浏览器永远不能读取它。Vercel → Lightning 的认证信息只在 Vercel server-side 使用。Vercel Queue 内部认证只留在 Vercel 环境中。
