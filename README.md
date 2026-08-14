# ID Photo Front

Next.js front end for the asynchronous ID-photo generation pipeline.

## Architecture

1. User submits one photo plus three output sizes.
2. Vercel stores the original in Cloudflare R2 and creates one Queue message per size.
3. The UI shows the number of queued jobs and does **not** start Lightning automatically.
4. The user clicks `开始处理（N 个任务）`.
5. Vercel locks the worker, creates short-lived R2 presigned GET/PUT URLs for the queued jobs, and calls `LIGHTNING_WAKE_URL`.
6. Lightning polls the Vercel Queue, processes jobs sequentially, updates job status through the worker API, and calls `/api/worker/finish` when the queue is empty so the GPU can stop immediately.

## Neon

Run `db/schema.sql` once in the connected Neon database.

The app uses:

```ts
import postgres from "postgres";
const sql = postgres(process.env.DATABASE_URL, { ssl: "verify-full" });
```

## Vercel environment variables

Required:

- `DATABASE_URL`
- `R2_ACCOUNT_ID`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `R2_BUCKET_NAME`
- `VERCEL_QUEUE_NAME` (recommended: `id-photo-jobs`)
- `LIGHTNING_WAKE_URL`
- `LIGHTNING_WAKE_TOKEN`
- `LIGHTNING_WORKER_TOKEN`

`LIGHTNING_WORKER_TOKEN` is used only by the Lightning worker when calling the job/status bridge APIs.

## Important Queue note

The Vercel Queue producer runs inside Vercel and uses the official `@vercel/queue` SDK. Lightning is an off-platform consumer and should use Vercel Queue **poll mode** with a properly scoped Vercel OIDC credential/token strategy. Do not put R2 access keys in Queue messages. The Queue message contains only the `jobId`.

## Install

After merging, regenerate the lockfile with the package manager used by the deployment environment (`npm install`) and deploy a new Vercel deployment.
