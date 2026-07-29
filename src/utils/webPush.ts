import webpush from 'web-push';
import { env } from '../config/env';
import { PushSubscription } from '../models/PushSubscription.model';

let configured = false;

const ensureConfigured = (): boolean => {
  if (configured) return true;
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return false;

  webpush.setVapidDetails(env.VAPID_SUBJECT, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
  configured = true;
  return true;
};

interface PushPayload {
  title:    string;
  message:  string;
  orderId?: string;
  // Optional explicit destination (e.g. '/worker/orders/<id>'). If omitted,
  // the service worker falls back to '/login' — middleware.ts auto-redirects
  // an already-logged-in visitor to their correct role dashboard, so this is
  // a safe default when the caller doesn't know which role's order-detail
  // route applies (sendPushToUser is called generically from
  // notificationService.create for customers AND workers).
  url?: string;
}

/**
 * Sends a push notification to every device a user has subscribed on.
 * Fire-and-forget from the caller's perspective — errors are swallowed
 * (logged only) so a push failure never breaks the actual in-app
 * notification flow this is bolted onto (see notification.service.ts).
 *
 * Any subscription the push service reports as gone (410/404 — user
 * uninstalled, revoked permission, cleared browser data) is deleted so we
 * stop wasting calls on it.
 */
export const sendPushToUser = async (userId: string, payload: PushPayload): Promise<void> => {
  if (!ensureConfigured()) return; // Not configured — silently skip

  const subscriptions = await PushSubscription.find({ userId });
  if (subscriptions.length === 0) return;

  const body = JSON.stringify({
    title: payload.title,
    body:  payload.message,
    orderId: payload.orderId,
    url: payload.url,
  });

  await Promise.all(
    subscriptions.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: sub.keys },
          body
        );
      } catch (err: any) {
        if (err?.statusCode === 404 || err?.statusCode === 410) {
          await PushSubscription.deleteOne({ _id: sub._id });
        } else {
          console.error('[WebPush] Send failed:', err?.statusCode, err?.message);
        }
      }
    })
  );
};

/**
 * Sends a push to every APPROVED worker who has subscribed — used when a new
 * order lands in the marketplace (see payment.service.ts), since that event
 * currently only reaches workers with the site open (Socket.IO broadcast to
 * the 'marketplace' room). This is what actually reaches a worker whose
 * phone screen is off / browser tab is closed.
 */
export const sendPushToAllWorkers = async (payload: PushPayload): Promise<void> => {
  if (!ensureConfigured()) return;

  // Only subscriptions belonging to approved workers — a customer or a
  // pending (not-yet-approved) worker shouldn't get "new order" pushes.
  const workerSubs = await PushSubscription.aggregate([
    {
      $lookup: {
        from: 'users', localField: 'userId', foreignField: '_id', as: 'user',
      },
    },
    { $unwind: '$user' },
    { $match: { 'user.role': 'worker', 'user.isApproved': true } },
    { $group: { _id: '$userId' } },
  ]);

  await Promise.all(workerSubs.map((s) => sendPushToUser(s._id.toString(), payload)));
};
