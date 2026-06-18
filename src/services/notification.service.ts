import { Notification } from '../models/Notification.model';
import { emitToUser, EVENTS } from '../socket/events';
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
    // Push real-time to the user's private socket room
    emitToUser(input.userId.toString(), EVENTS.NOTIFICATION, notif);
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
