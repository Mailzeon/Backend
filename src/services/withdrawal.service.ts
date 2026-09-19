import { WithdrawRequest, IWithdrawRequest } from '../models/WithdrawRequest.model';
import { Wallet } from '../models/Wallet.model';
import { walletService } from './wallet.service';
import { notificationService } from './notification.service';
import { emitToUser, EVENTS } from '../socket/events';

const throwErr = (msg: string, code = 400): never => {
  throw Object.assign(new Error(msg), { statusCode: code });
};

// Shown to the worker on the withdrawal form itself (see the frontend
// wallet page) AND referenced here so the backend's own rejection message
// says the exact same thing — the two must never drift apart, since this
// is the one instruction whose exact wording actually matters: a worker
// who mistypes their own name (even a shortened/nickname version that
// doesn't match their UPI app's bank-registered name) gets their
// withdrawal rejected once admin spots the mismatch while paying.
export const UPI_NAME_INSTRUCTIONS =
  'Type the EXACT name your own UPI app shows for this UPI ID (open your UPI app, check the name it displays for this ID) — not your Mailzeon account name. ' +
  'If the name you type here doesn\u2019t exactly match what your UPI app shows, your withdrawal will be rejected.';

export const withdrawalService = {
  async create(workerId: string, data: {
    amount: number; paymentMethod: 'upi' | 'bank'; upiId?: string;
    upiQrCode?: string; upiVerifiedName?: string;
    bankDetails?: { accountHolder: string; accountNumber: string; ifscCode: string; bankName: string; };
  }): Promise<IWithdrawRequest> {
    const { amount, paymentMethod, upiId, upiQrCode, upiVerifiedName, bankDetails } = data;
    if (amount < 1) throwErr('Minimum withdrawal is ₹1.');

    // CHANGED: a UPI withdrawal now needs all three of UPI ID + a QR
    // screenshot + the worker's own typed name, not just the ID alone —
    // this is what lets admin visually cross-check (scan the QR, see if
    // the name it shows matches what was typed here) before actually
    // paying, catching a wrong/mistyped UPI ID before money is sent to
    // the wrong person rather than after.
    if (paymentMethod === 'upi') {
      if (!upiId?.trim())          throwErr('UPI ID is required.');
      if (!upiQrCode?.trim())      throwErr('A screenshot of your UPI QR code is required.');
      if (!upiVerifiedName?.trim()) throwErr('Enter the name your UPI app shows for this ID.');
    }
    if (paymentMethod === 'bank' && !bankDetails?.accountNumber) throwErr('Bank account number is required.');

    // Debit from wallet immediately — holds funds during processing
    await walletService.debit(workerId, amount, `Withdrawal request: ₹${amount}`);

    return WithdrawRequest.create({ workerId, amount, paymentMethod, upiId, upiQrCode, upiVerifiedName, bankDetails });
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
