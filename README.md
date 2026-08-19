# ID Photo Front

Next.js front end for the asynchronous ID-photo generation pipeline.

## Architecture

1. User submits one photo plus three output sizes.
2. Vercel stores the original in Cloudflare R2 and creates one Queue message per size.
3. The UI shows the number of queued jobs and does **not** start the backend automatically.
4. The user clicks `开始处理（N 个任务）`.
5. Vercel calls the backend through Pangolin and authenticates with Pangolin access-token headers.
6. The backend polls the Queue one message at a time. Only when it asks for a job does Vercel generate short-lived R2 presigned GET/PUT URLs.
7. The backend processes jobs strictly sequentially, updates job status through the worker API, and calls `/api/worker/finish` when the Queue is empty.

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
- `PANGOLIN_API_URL` (for example `https://id-photo.example.com/`)
- `PANGOLIN_ACCESS_TOKEN_ID`
- `PANGOLIN_ACCESS_TOKEN`

`PANGOLIN_API_URL` can be either the protected site root or the full `/process-queue` URL. The Vercel app automatically appends `/process-queue` when needed.

Example Queue configuration:

```env
VERCEL_QUEUE_NAME=id-photo-jobs
VERCEL_QUEUE_REGION=iad1
VERCEL_QUEUE_CONSUMER_GROUP=lightning-worker
```

## Security

The two Pangolin tokens must remain server-side Vercel environment variables and must never use a `NEXT_PUBLIC_` prefix. The backend never receives long-lived R2 credentials. R2 access is provided through short-lived presigned URLs generated only when a job is actually pulled for processing.

## Deploy to Vercel

1. Import this repository in Vercel and keep the framework preset as Next.js.
2. Create all environment variables listed above for Production (and Preview if needed). Keep the Pangolin token variables server-only.
3. Confirm the Pangolin resource points to the FastAPI service and allows `POST /process-queue`.
4. Deploy. The `vercel-build` script runs database migrations before the Next.js production build.
5. After deployment, sign in, submit one photo, click Start, and verify that the job reaches `completed`.

For CLI deployment, run `vercel`, add secrets with `vercel env add NAME production`, then run `vercel --prod`.
