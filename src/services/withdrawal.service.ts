import { WithdrawRequest, IWithdrawRequest } from '../models/WithdrawRequest.model';
import { Wallet } from '../models/Wallet.model';
import { walletService } from './wallet.service';
import { notificationService } from './notification.service';
import { emitToUser, EVENTS } from '../socket/events';

const throwErr = (msg: string, code = 400): never => {
  throw Object.assign(new Error(msg), { statusCode: code });
};

export const withdrawalService = {
  async create(workerId: string, data: {
    amount: number; paymentMethod: 'upi' | 'bank'; upiId?: string;
    bankDetails?: { accountHolder: string; accountNumber: string; ifscCode: string; bankName: string; };
  }): Promise<IWithdrawRequest> {
    const { amount, paymentMethod, upiId, bankDetails } = data;
    if (amount < 1)                                   throwErr('Minimum withdrawal is ₹1.');
    if (paymentMethod === 'upi'  && !upiId?.trim())   throwErr('UPI ID is required.');
    if (paymentMethod === 'bank' && !bankDetails?.accountNumber) throwErr('Bank account number is required.');

    // Debit from wallet immediately — holds funds during processing
    await walletService.debit(workerId, amount, `Withdrawal request: ₹${amount}`);

    return WithdrawRequest.create({ workerId, amount, paymentMethod, upiId, bankDetails });
  },

  async getMyRequests(workerId: string): Promise<IWithdrawRequest[]> {
    return WithdrawRequest.find({ workerId }).sort({ createdAt: -1 });
  },

  async getAllRequests(): Promise<IWithdrawRequest[]> {
    return WithdrawRequest.find()
      .populate('workerId', 'name email')
      .sort({ createdAt: -1 });
  },

  async updateStatus(id: string, status: string, adminNote?: string): Promise<IWithdrawRequest> {
    const req = await WithdrawRequest.findByIdAndUpdate(
      id,
      { status, adminNote, processedAt: new Date() },
      { new: true }
    ).populate('workerId', 'name email _id');

    if (!req) throwErr('Withdrawal request not found.', 404);

    // BUG FIX: After populate(), workerId is a full document — extract _id from it
    const populated = req!.workerId as unknown as { _id: { toString(): string } };
    const workerId  = populated._id.toString();

    if (status === 'completed') {
      emitToUser(workerId, EVENTS.WITHDRAWAL_DONE, { amount: req!.amount });
      await notificationService.create({
        userId:  workerId,
        title:   '✅ Withdrawal Processed!',
        message: `Your withdrawal of ₹${req!.amount} has been processed successfully.`,
        type:    'withdrawal',
      });

    } else if (status === 'rejected') {
      // Refund amount back to worker's available balance
      await Wallet.findOneAndUpdate(
        { userId: workerId },
        { $inc: { balance: req!.amount } }
      );
      await notificationService.create({
        userId:  workerId,
        title:   '❌ Withdrawal Rejected',
        message: `Your withdrawal of ₹${req!.amount} was rejected. Funds returned to your wallet.${adminNote ? ' Reason: ' + adminNote : ''}`,
        type:    'withdrawal',
      });
    }

    return req!;
  },
};
