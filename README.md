# ID Photo Front

Next.js front end for the asynchronous ID-photo generation pipeline.

## Architecture

1. User submits one photo plus the selected output sizes.
2. Vercel stores the original in Cloudflare R2 and creates one Queue message per size.
3. The UI shows the number of queued jobs and does **not** start the backend automatically.
4. The user clicks `开始处理（N 个任务）`.
5. Vercel calls the Modal CPU control endpoint with a dedicated server-side Bearer token. Modal is the only processing backend; there is no location picker or Oracle fallback.
6. Modal starts a detached L4 GPU worker using `birefnet-v1-lite + retinaface` with CUDA. The worker claims durable database jobs first, then Queue notifications one at a time. Vercel generates short-lived R2 presigned GET/PUT URLs only when a job is claimed.
7. Modal acknowledges scheduling immediately; GPU heartbeats confirm readiness. The worker processes jobs sequentially, updates status through the worker API, and calls `/api/worker/finish` when the Queue is empty.
8. The UI automatically refreshes progress and backend health. Status requests do not access R2. Results retain HD resolution and the chosen aspect ratio.

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
- `VERCEL_QUEUE_NAME`
- `VERCEL_QUEUE_REGION`
- `VERCEL_QUEUE_CONSUMER_GROUP`
- `MODAL_API_URL` (`https://jiojiojackson--id-photo-gpu-web.modal.run`)
- `MODAL_BACKEND_TOKEN`

`MODAL_API_URL` can be the Modal control endpoint root or its full `/process-queue` URL. The Vercel app appends `/process-queue` when needed. New jobs and worker runs default to `modal`; historical location records are preserved.

Example Queue configuration:

```env
VERCEL_QUEUE_NAME=id-photo-jobs
VERCEL_QUEUE_REGION=iad1
VERCEL_QUEUE_CONSUMER_GROUP=lightning-worker
```

## Security

`MODAL_BACKEND_TOKEN` stays in server-side Vercel environment variables and the Modal Secret `id-photo-modal-control`, without a `NEXT_PUBLIC_` prefix. The Modal account token is not needed in Vercel. The worker never receives long-lived R2 credentials. R2 access uses short-lived presigned URLs generated only when a job is claimed. Status and health requests use CPU functions and never allocate a GPU.

## Deploy to Vercel

1. Import this repository in Vercel and keep the framework preset as Next.js.
2. Create all environment variables listed above for Production (and Preview if needed). Keep the Modal token server-only.
3. Deploy the backend's `modal_app.py` to Modal. Set its Secret's `ALLOWED_VERCEL_ORIGINS` to the exact frontend origins that can call the worker bridge.
4. Deploy. The `vercel-build` script runs database migrations before the Next.js production build.
5. After deployment, sign in, submit one photo, click Start, and verify that the job reaches `completed`.

For CLI deployment, run `vercel`, add secrets with `vercel env add NAME production`, then run `vercel --prod`.

Run `npm test` for Modal dispatch, worker lifecycle, pagination, and bounded R2 cleanup tests. See [R2_AUDIT.md](R2_AUDIT.md) for storage request behavior and diagnostics.
