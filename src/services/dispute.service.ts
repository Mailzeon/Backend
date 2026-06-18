import { Dispute, IDispute } from '../models/Dispute.model';
import { Order } from '../models/Order.model';
import { User } from '../models/User.model';
import { Notification } from '../models/Notification.model';

const throwErr = (msg: string, code = 400): never => {
  throw Object.assign(new Error(msg), { statusCode: code });
};

export const disputeService = {
  async create(orderId: string, customerId: string, reason: string, description?: string): Promise<IDispute> {
    const order = await Order.findOne({ _id: orderId, customerId, status: 'under_review' });
    if (!order) throwErr('Order must first be reported (status: under_review) before creating a dispute.', 400);
    if (!order!.workerId) throwErr('No worker assigned to this order.', 400);

    const existing = await Dispute.findOne({ orderId });
    if (existing) throwErr('A dispute already exists for this order.', 409);

    const dispute = await Dispute.create({
      orderId, customerId, workerId: order!.workerId, reason, description,
    });

    // Notify all admin accounts
    const admins = await User.find({ role: 'admin' }).select('_id');
    if (admins.length > 0) {
      await Notification.insertMany(admins.map(a => ({
        userId:  a._id,
        title:   '🚨 New Dispute',
        message: `A customer raised a dispute for Order #${orderId.slice(-6).toUpperCase()}.`,
        type:    'dispute',
        orderId: order!._id,
        isRead:  false,
        createdAt: new Date(),
      })));
    }

    return dispute;
  },

  async getAll(): Promise<IDispute[]> {
    return Dispute.find()
      .populate('orderId', 'serviceName amount status')
      .populate('customerId', 'name email')
      .populate('workerId', 'name email')
      .sort({ createdAt: -1 });
  },

  async getMyDisputes(customerId: string): Promise<IDispute[]> {
    return Dispute.find({ customerId })
      .populate('orderId', 'serviceName status')
      .sort({ createdAt: -1 });
  },

  async resolve(id: string, status: 'resolved' | 'rejected', adminNote?: string): Promise<IDispute> {
    const dispute = await Dispute.findByIdAndUpdate(
      id,
      { status, adminNote, resolvedAt: new Date() },
      { new: true }
    ).populate('orderId', 'serviceName');

    if (!dispute) throwErr('Dispute not found.', 404);
    return dispute!;
  },
};
