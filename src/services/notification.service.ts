import { Notification } from '../models/Notification.model';
import { User } from '../models/User.model';
import { emitToUser, EVENTS } from '../socket/events';
import { sendPushToUser } from '../utils/webPush';
import { sendNotificationEmail } from '../utils/email';
import { NotificationType } from '../types';
import { Types } from 'mongoose';

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

    // NEW: mirror every notification to the user's registered email too.
    // Fire-and-forget for the same reason as the push call above — an
    // email failure (or Brevo's 300/day free-tier limit being hit) must
    // never break the actual notification/DB write.
    User.findById(input.userId).select('email').lean()
      .then((user) => {
        if (user?.email) {
          return sendNotificationEmail(user.email, input.title, input.message);
        }
      })
      .catch(err => console.error('[Notification] Email send failed:', err));

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
