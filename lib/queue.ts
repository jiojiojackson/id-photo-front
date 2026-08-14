import { send } from "@vercel/queue";

export const PHOTO_QUEUE_NAME = process.env.VERCEL_QUEUE_NAME || "id-photo-jobs";
export const PHOTO_CONSUMER_GROUP = process.env.VERCEL_QUEUE_CONSUMER_GROUP || "lightning-worker";

export async function enqueueJob(jobId: string) {
  return send(PHOTO_QUEUE_NAME, { jobId }, {
    idempotencyKey: jobId,
    retentionSeconds: 24 * 60 * 60,
  });
}
