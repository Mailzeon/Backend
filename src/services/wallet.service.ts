import { Wallet } from '../models/Wallet.model';
import { Transaction } from '../models/Transaction.model';
import { Types } from 'mongoose';

export const walletService = {
  /** Get wallet, creating it with zero balance if it doesn't exist */
  async getOrCreate(userId: Types.ObjectId | string) {
    return Wallet.findOneAndUpdate(
      { userId },
      { $setOnInsert: { userId, balance: 0, pendingBalance: 0, totalEarned: 0 } },
      { upsert: true, new: true }
    );
  },

  async getBalance(userId: string) {
    return walletService.getOrCreate(userId);
  },

  /** Hold earnings in pending during order processing */
  async moveToPending(
    userId: Types.ObjectId | string,
    amount: number,
    orderId: Types.ObjectId | string,
    description: string
  ) {
    await walletService.getOrCreate(userId);
    await Wallet.findOneAndUpdate({ userId }, { $inc: { pendingBalance: amount } });
    await Transaction.create({ userId, orderId, type: 'credit', amount, status: 'pending', description });
  },

  /** Release earnings from pending to available balance */
  async releaseFromPending(
    userId: Types.ObjectId | string,
    amount: number,
    orderId: Types.ObjectId | string,
    description: string
  ) {
    await Wallet.findOneAndUpdate(
      { userId },
      { $inc: { balance: amount, pendingBalance: -amount, totalEarned: amount } }
    );
    // Update the pending transaction to completed
    await Transaction.findOneAndUpdate(
      { userId, orderId, status: 'pending', type: 'credit' },
      { status: 'completed', description }
    );
  },

  /** Debit from available balance (for withdrawals) */
  async debit(userId: Types.ObjectId | string, amount: number, description: string) {
    const wallet = await Wallet.findOneAndUpdate(
      { userId, balance: { $gte: amount } },   // Atomic check: fails if insufficient funds
      { $inc: { balance: -amount } },
      { new: true }
    );
    if (!wallet) {
      throw Object.assign(new Error('Insufficient balance.'), { statusCode: 400 });
    }
    await Transaction.create({ userId, type: 'withdrawal', amount, status: 'completed', description });
    return wallet;
  },

  async getTransactions(userId: string) {
    return Transaction.find({ userId }).sort({ createdAt: -1 }).limit(100).lean();
  },
};
