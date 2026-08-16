# DEV_STATE

当前开发分支：`agent/queue-worker-bridge`

本项目正式前端架构为 Vercel + Neon + R2 + Vercel Queue + Lightning。后端 `id-photo-back` 已调试完成，本阶段不修改后端。

## 当前 Production 状态

前端已经从 Debug/开发模式收敛为正式 Lightning Platform 调用模式，并完成 UI 分页重构。

- 已删除 `DEBUG_DIRECT_BACKEND` 代码逻辑。
- `/api/jobs/start` 必须同时配置 `LIGHTNING_API_URL` 和 `LIGHTNING_API_KEY`。
- 唤醒 Lightning 时固定使用 `Authorization: Bearer <LIGHTNING_API_KEY>`。
- Worker Credential 仍由 Vercel 在开始处理时生成，短期有效，只保存 hash 到 Neon，并通过 wake payload 传给 Lightning。
- `bridge_url` / `vercel_origin` 使用当前 Vercel 请求 origin 动态生成，不硬编码域名。
- `/api/jobs/status` 仍然只访问 Neon/Queue，不访问 Lightning、不调用 `/process-queue`、不重新唤醒 Worker。
- 前端没有自动 status polling；任务状态由用户操作触发查询。
- `id-photo-back` 保持当前已调试版本，不需要修改。

## 当前 UI Production 状态

前端已经从单页长网页改为三个主要页面：

```text
/create
  ↓
制作：上传照片 + 设置尺寸
  ↓
/jobs
  ↓
任务：查看队列 + 手动刷新 + 开始处理
  ↓
/results
  ↓
结果：选择生成图片 + 调整背景色 + 下载
```

### `/create` 制作页

- 只让用户提交照片和尺寸。
- 提交时不再要求输入背景色。
- DPI 固定为 300 发送给现有 `/api/jobs/submit`。
- 尺寸输入框改为字符串 draft state，可以正常删除全部数字后重新输入，不会在每次按键时被 `normalize()` 强制恢复。
- 提交前才验证尺寸必须为 100～3000 的整数。
- 保留常用尺寸 preset。
- 上传照片后本地预览，并在提交前自动压缩到 2 MB 以内。

### `/jobs` 任务页

- 独立显示任务队列。
- 显示待处理、处理中、已完成、失败数量。
- 手动“刷新状态”。
- “开始处理”仍然是唯一触发 `/api/jobs/start` 的用户操作。
- 已完成任务提供“调整结果”入口。
- 支持返回 `/create` 新建任务。

### `/results` 结果页

- 只展示已完成 Job。
- 每个生成尺寸可独立选择。
- 增加背景色调整工具。
- 内置常见背景色：白、浅灰、深灰、证件蓝、浅蓝、深蓝、米白、淡粉。
- 使用原生 `<input type="color">` 提供自定义调色盘。
- 调整结果实时绘制到 Canvas。
- 下载按钮下载当前 Canvas 中的最终 PNG。
- 原生成结果不被覆盖，颜色调整只发生在浏览器端。

结果图片增加同源代理：

```text
GET /api/jobs/image?jobId=...
```

该 API 由 Vercel 根据 Job 的 `output_key` 生成短期 R2 GET URL，服务器读取图片后返回给浏览器。这样结果编辑 Canvas 不依赖 R2 bucket 的浏览器 CORS 配置，也不会把 R2 凭证暴露给客户端。

当前背景替换算法基于结果图四角/左上角采样原背景色，对接近原背景色的像素进行颜色替换，并对边缘进行渐变混合，以尽量保留人物边缘。

## 正式版 Lightning 调用链

```text
用户点击“开始处理”
        ↓
POST /api/jobs/start
        ↓
Neon 创建 worker_run
        ↓
生成短期 Worker Credential
        ↓
POST LIGHTNING_API_URL/process-queue
Authorization: Bearer LIGHTNING_API_KEY
        ↓
Lightning Worker
        ↓
POST /api/worker/next
POST /api/worker/heartbeat
POST /api/worker/complete
POST /api/worker/fail
POST /api/worker/finish
```

`/api/jobs/start` 是唯一允许产生 Vercel → Lightning 唤醒请求的入口。

## 状态与 Worker 失联

Worker Bridge 会通过 `next`、`heartbeat`、`complete`、`fail`、`finish` 更新 `photo_worker_runs.last_seen_at`。

如果 Lightning/Worker 整体崩溃，heartbeat 停止。超过 120 秒后，用户手动刷新 `/api/jobs/status` 时执行 stale reconcile：

```text
processing Job
      ↓
Worker Run stale / credential expired
      ↓
Job → failed
Worker Run → failed
photo_worker_state → idle
```

失联 Job 不自动重新排队，也不会因为 status reconcile 自动重新唤醒 Lightning。单个 Job 主动调用 `/api/worker/fail` 时仍保留原有 `MAX_ATTEMPTS=5` 重试逻辑。

## 前端状态请求规则

- 不设置自动轮询。
- 提交任务成功后进入任务页。
- 开始处理成功后可手动刷新状态。
- 用户点击“刷新任务状态”时请求一次。
- 结果页读取结果时查询一次 `/api/jobs/status`，只用于加载已完成结果；不会唤醒 Lightning。
- 处理过程中不自动轮询。
- Worker 崩溃后不自动唤醒。
- `/api/jobs/status` stale reconcile 只修改 Neon 状态，不产生 Lightning 网络请求。

核心原则：**查看状态和唤醒 Lightning 完全解耦。**

## API 单向访问边界

```text
用户点击开始
    ↓
/api/jobs/start
    ↓
Lightning /process-queue
```

```text
用户查看任务/结果
    ↓
/api/jobs/status
    ↓
Neon / Queue
```

`/api/jobs/status` 禁止：

- 访问 `LIGHTNING_API_URL`
- 调用 `/process-queue`
- 调用 wake Lightning
- 因 stale 自动创建 Worker Run

Lightning → Vercel Bridge 允许：

```text
/api/worker/next
/api/worker/heartbeat
/api/worker/complete
/api/worker/fail
/api/worker/finish
```

这些接口使用短期 Worker Credential，不使用浏览器 Cookie。

## Vercel Build 修复

此前 `app/api/worker/heartbeat/route.ts` 因 postgres 查询结果在 TypeScript 中被推断为 `unknown[]`，导致 Vercel build 在 type check 阶段失败。

已通过显式 `LeaseRow` 类型修复：

```ts
type LeaseRow = { lease_expires_at: Date | string };
const leaseRows = await tx<LeaseRow[]>`...`;
```

该修复只解决类型检查，不改变 heartbeat、lease 或数据库业务逻辑，也不需要 migration。

修复提交：`1af3e2b6e55b3a6f62eef2e10be59a2ddded8de5`

## Production 收敛

正式版提交：`da10e349af270e7e5546d4a82bd7ff9b64d30dc3`

本提交：

1. 删除 `DEBUG_DIRECT_BACKEND`。
2. 强制 `LIGHTNING_API_KEY`。
3. Lightning wake 请求固定携带 Bearer API Key。
4. 保留 Worker Credential、Bridge、动态 Vercel origin 和 stale reconcile。
5. 不修改后端仓库。

## UI 重构提交

本阶段新增/修改：

- `components/AppShell.tsx`：统一顶部导航、退出登录和页面壳。
- `app/create/page.tsx`：制作分页。
- `app/jobs/page.tsx`：任务分页。
- `app/results/page.tsx`：结果编辑分页。
- `app/api/jobs/image/route.ts`：R2 结果图片同源代理。
- `app/page.tsx`：根路径重定向到 `/create`。
- `app/globals.css`：完整响应式 UI 重设计。

重要修复：原 `/` 页面尺寸输入使用数字 state + 每次输入调用 `normalize()`，导致用户无法删除现有数字或输入自定义数字。现在使用字符串 draft state，只有提交时验证和转换。

本阶段没有修改 `/api/jobs/submit` 的数据库业务逻辑；前端不再发送背景色字段，因此后端按现有默认值 `#ffffff` 处理初始背景。

## Migration

Vercel build 自动执行：

```text
npm run db:migrate
↓
next build
```

本阶段没有数据库 schema 变化，不需要新的 migration。

## 当前分支

Frontend：`agent/queue-worker-bridge`

Backend：`agent/queue-worker-bridge`（本阶段未修改）

## Production 验证清单

1. Vercel Production 配置 `LIGHTNING_API_URL` 与 `LIGHTNING_API_KEY`。
2. 删除 Vercel Project Settings 中遗留的 `DEBUG_DIRECT_BACKEND`（如果存在）。
3. 确认 Production Build 通过。
4. `/create` 中可以把尺寸输入框内容全部删除，然后输入任意合法整数。
5. 提交任务时确认不再出现背景色输入。
6. 确认提交后进入 `/jobs`，不会唤醒 Lightning。
7. 点击开始处理，确认 `/api/jobs/start` 唤醒 Lightning，并发送 Bearer API Key。
8. 确认 Lightning → Bridge → R2 → inference → complete → finish 正常。
9. `/jobs` 手动刷新，确认不会产生 Lightning 请求。
10. 完成后进入 `/results`，确认各尺寸结果可以切换。
11. 测试白、蓝、灰等预设背景色。
12. 测试自定义颜色选择器。
13. 点击下载，确认下载文件是当前调整后的 PNG，而不是原始结果。
14. 停止 Lightning Worker，等待超过 120 秒后手动刷新，确认 Job → failed、Worker State → idle，且不会自动重新唤醒 Lightning。
15. 最后进行多 Job、heartbeat、lease recovery、重复 complete、fail/retry 的回归测试。
