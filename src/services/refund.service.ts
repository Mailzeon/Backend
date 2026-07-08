import { RefundRequest, IRefundRequest } from '../models/RefundRequest.model';
import { Order } from '../models/Order.model';
import { Dispute } from '../models/Dispute.model';
import { User } from '../models/User.model';
import { notificationService } from './notification.service';

const throwErr = (msg: string, code = 400): never => {
  throw Object.assign(new Error(msg), { statusCode: code });
};

export const refundService = {
  // A refund can only be requested when:
  //   1. The order belongs to this customer
  //   2. The order is 'cancelled'
  //   3. That cancellation came from a dispute resolved IN THE CUSTOMER'S
  //      FAVOR (Dispute.status === 'resolved') — self-cancelled pending
  //      orders are NOT eligible, since no payment was actually processed
  //      for a service that was never attempted.
  //   4. No refund request already exists for this order
  async create(orderId: string, customerId: string, upiId: string): Promise<IRefundRequest> {
    const order = await Order.findOne({ _id: orderId, customerId, status: 'cancelled' });
    if (!order) throwErr('This order is not eligible for a refund.', 400);

    const dispute = await Dispute.findOne({ orderId, status: 'resolved' });
    if (!dispute) throwErr('This order is not eligible for a refund.', 400);

    const existing = await RefundRequest.findOne({ orderId });
    if (existing) throwErr('A refund request already exists for this order.', 409);

    const refund = await RefundRequest.create({
      orderId, customerId, amount: order.amount, upiId,
    });

    const admins = await User.find({ role: 'admin' }).select('_id');
    if (admins.length > 0) {
      await Promise.all(admins.map(a =>
        notificationService.create({
          userId:  a._id,
          title:   '💸 New Refund Request',
          message: `A customer requested a refund of ₹${order.amount} for Order #${order._id.toString().slice(-6).toUpperCase()}.`,
          type:    'system',
        })
      ));
    }

    return refund;
  },

  async getMyRefunds(customerId: string): Promise<IRefundRequest[]> {
    return RefundRequest.find({ customerId })
      .populate('orderId', 'serviceName')
      .sort({ createdAt: -1 });
  },

  async getAllRefunds(): Promise<IRefundRequest[]> {
    return RefundRequest.find()
      .populate('customerId', 'name email')
      .populate('orderId', 'serviceName')
      .sort({ createdAt: -1 });
  },

  async updateStatus(id: string, status: 'completed' | 'rejected', adminNote?: string): Promise<IRefundRequest> {
    const refund = await RefundRequest.findByIdAndUpdate(
      id,
      { status, adminNote, processedAt: new Date() },
      { new: true }
    );
    if (!refund) throwErr('Refund request not found.', 404);

    if (status === 'completed') {
      await notificationService.create({
        userId:  refund!.customerId,
        title:   '✅ Refund Processed!',
        message: `Your refund of ₹${refund!.amount} has been processed successfully.`,
        type:    'system',
      });
    } else {
      await notificationService.create({
        userId:  refund!.customerId,
        title:   'Refund Request Rejected',
        message: `Your refund request was rejected.${adminNote ? ' Reason: ' + adminNote : ''}`,
        type:    'system',
      });
    }

    return refund!;
  },
};
