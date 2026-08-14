# ID Photo Front

Next.js front end for the asynchronous ID-photo generation pipeline.

## Architecture

1. User submits one photo plus three output sizes.
2. Vercel stores the original in Cloudflare R2 and creates one Queue message per size.
3. The UI shows the number of queued jobs and does **not** start Lightning automatically.
4. The user clicks `开始处理（N 个任务）`.
5. Vercel re-publishes the DB's queued jobs idempotently, then calls `LIGHTNING_API_URL` with `LIGHTNING_API_KEY`.
6. Lightning polls the Queue one message at a time. Only when Lightning asks for a job does Vercel generate short-lived R2 presigned GET/PUT URLs.
7. Lightning processes jobs strictly sequentially, updates job status through the worker API, and calls `/api/worker/finish` when the Queue is empty so the GPU can stop immediately.

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
- `LIGHTNING_API_URL`
- `LIGHTNING_API_KEY`

Queue topic (`id-photo-jobs`), consumer group (`lightning-worker`), and polling region (`iad1`) are application configuration and are not environment variables.

## Security

The same `LIGHTNING_API_KEY` is used by the Vercel bridge to authenticate Lightning. Lightning never receives long-lived R2 credentials. R2 access is provided through short-lived presigned URLs generated only when a job is actually pulled for processing.

## Queue region

Poll mode requires a fixed Queue region. The project is pinned to `iad1` in `vercel.json`, and the Queue client uses the same fixed region in code. This avoids a user-managed `VERCEL_QUEUE_REGION` variable while keeping send/receive in the same Queue region.

## Install

After merging, run `npm install` (or use the generated lockfile if your branch already has one) and deploy a new Vercel deployment.
