import { PollingQueueClient } from "@vercel/queue";

export const PHOTO_QUEUE_NAME = process.env.VERCEL_QUEUE_NAME || "id-photo-jobs";
export const PHOTO_QUEUE_CONSUMER = process.env.VERCEL_QUEUE_CONSUMER_GROUP || "lightning-worker";
export const PHOTO_QUEUE_REGION = process.env.VERCEL_QUEUE_REGION || "iad1";

const queue = new PollingQueueClient({
  region: PHOTO_QUEUE_REGION,
  deploymentId: null,
});

export const { send, receive } = queue;

export async function enqueueJob(jobId: string) {
  return send(PHOTO_QUEUE_NAME, { jobId }, {
    idempotencyKey: jobId,
    retentionSeconds: 24 * 60 * 60,
  });
}
