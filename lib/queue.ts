import { Queue } from "@vercel/queue";

export const PHOTO_QUEUE_NAME = process.env.VERCEL_QUEUE_NAME || "id-photo-jobs";

export function getPhotoQueue() {
  return new Queue(PHOTO_QUEUE_NAME);
}
