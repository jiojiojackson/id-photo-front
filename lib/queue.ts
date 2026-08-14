import { PollingQueueClient } from "@vercel/queue";

// Keep the Queue topic and polling region as application configuration, not
// user-managed environment variables. Poll mode requires a fixed region.
export const PHOTO_QUEUE_NAME = "id-photo-jobs";
export const PHOTO_QUEUE_CONSUMER = "lightning-worker";
export const PHOTO_QUEUE_REGION = "iad1";

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
