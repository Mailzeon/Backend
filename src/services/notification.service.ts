import { Notification } from '../models/Notification.model';
import { User } from '../models/User.model';
import { emitToUser, EVENTS } from '../socket/events';
import { sendPushToUser } from '../utils/webPush';
import { sendNotificationEmail } from '../utils/email';
import { telegramBotService } from './telegramBot.service';
import { NotificationType } from '../types';
import { Types } from 'mongoose';

// Telegram-origin accounts get an internal placeholder email (see
// auth.service.ts telegramLogin()) — never worth spending an email send
// (or Brevo's 300/day free-tier quota) on an address nothing real will
// ever receive.
const isPlaceholderTelegramEmail = (email: string): boolean =>
  /^tg_\d+@telegram\.mailzeon\.internal$/.test(email);

interface CreateNotifInput {
  userId:   Types.ObjectId | string;
  title:    string;
  message:  string;
  type:     NotificationType;
  orderId?: Types.ObjectId | string;
}

export const notificationService = {
  async create(input: CreateNotifInput) {
    const notif = await Notification.create(input);
    // Push real-time to the user's private socket room (only reaches them
    // if the site is open in a tab right now)
    emitToUser(input.userId.toString(), EVENTS.NOTIFICATION, notif);

    // NEW: also push to their phone/browser via the Push API, which reaches
    // them even with the site closed — this is the actual fix for "worker
    // isn't on the site 24/7 but still needs to know an order came in".
    // Fire-and-forget: never let a push failure block/break the DB write or
    // socket emit above, which are the parts everything else depends on.
    sendPushToUser(input.userId.toString(), {
      title: input.title,
      message: input.message,
      orderId: input.orderId?.toString(),
    }).catch(err => console.error('[Notification] Push send failed:', err));

    // NEW: mirror every notification to the user's registered email, AND
    // to their Telegram chat if they have one linked — fire-and-forget for
    // the same reason as the push call above.
    //
    // Telegram is the effective "push notification channel" for anyone who
    // signed up (or logged in) via the Mini App: the standard browser Push
    // API above does NOT work inside Telegram's WebView at all (it's a
    // sandboxed context, no Service Worker support) — without this, a
    // Telegram-origin user would get literally zero notifications
    // whenever the Mini App itself isn't open, unlike web/PWA users.
    User.findById(input.userId).select('email telegramId').lean()
      .then((user) => {
        if (user?.email && !isPlaceholderTelegramEmail(user.email)) {
          sendNotificationEmail(user.email, input.title, input.message)
            .catch(err => console.error('[Notification] Email send failed:', err));
        }
        if (user?.telegramId) {
          telegramBotService.sendMessage(user.telegramId, `${input.title}\n\n${input.message}`)
            .catch(err => console.error('[Notification] Telegram send failed:', err));
        }
      })
      .catch(err => console.error('[Notification] User lookup for email/telegram failed:', err));

    return notif;
  },

  async getForUser(userId: string) {
    return Notification.find({ userId }).sort({ createdAt: -1 }).limit(50).lean();
  },

  async markRead(id: string, userId: string) {
    await Notification.findOneAndUpdate({ _id: id, userId }, { isRead: true });
  },

  async markAllRead(userId: string) {
    await Notification.updateMany({ userId, isRead: false }, { isRead: true });
  },
};
