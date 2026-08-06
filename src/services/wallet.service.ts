import { Wallet } from '../models/Wallet.model';
import { Transaction } from '../models/Transaction.model';
import { Types } from 'mongoose';
import { notificationService } from './notification.service';

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

  // NEW: Reverses a pending amount WITHOUT crediting it to balance/totalEarned.
  // Used when a dispute is resolved AGAINST the worker — the order is
  // cancelled and the worker should not be paid for it. Unlike
  // releaseFromPending, this only removes the held pendingBalance; the
  // money never becomes available or counted as earned.
  async reversePendingEarnings(
    userId: Types.ObjectId | string,
    amount: number,
    orderId: Types.ObjectId | string,
    description: string
  ) {
    await Wallet.findOneAndUpdate(
      { userId },
      { $inc: { pendingBalance: -amount } }
    );
    await Transaction.findOneAndUpdate(
      { userId, orderId, status: 'pending', type: 'credit' },
      { status: 'failed', description }
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

  // NEW: instant refund-as-wallet-credit. Used whenever a paid order is
  // cancelled — whether the customer cancelled it themselves (before any
  // worker accepted) or a dispute/auto-cancel resolved in their favor.
  // Credits `balance` directly (not `pendingBalance`) since there's no
  // holding period to wait out — the customer can spend it on their very
  // next order immediately. This replaces the old manual "request a UPI
  // refund → admin pays by hand" flow for these cases entirely.
  async creditRefund(
    userId: Types.ObjectId | string,
    amount: number,
    orderId: Types.ObjectId | string,
    description: string
  ) {
    await walletService.getOrCreate(userId);
    await Wallet.findOneAndUpdate({ userId }, { $inc: { balance: amount } });
    await Transaction.create({ userId, orderId, type: 'credit', amount, status: 'completed', description });
  },

  // ── Add Funds via Cashfree ─────────────────────────────────────────────
  // Step 1: create a 'pending' recharge Transaction BEFORE talking to
  // Cashfree — its own _id becomes the basis for the order_id we send them
  // (`WALLET-<transactionId>`), which is how the webhook later finds its
  // way back here. Nothing is credited to the wallet yet.
  async initiateRecharge(userId: string, amount: number) {
    return Transaction.create({
      userId, type: 'recharge', amount, status: 'pending',
      description: `Wallet recharge — ₹${amount}`,
    });
  },

  // Step 2 (called right after Cashfree confirms the order was created):
  // stamp the transaction with the exact cashfreeOrderId so the webhook
  // can look it up.
  async attachCashfreeOrderId(transactionId: string, cashfreeOrderId: string) {
    await Transaction.findByIdAndUpdate(transactionId, { cashfreeOrderId });
  },

  // Step 3: webhook (or verify-on-return fallback) calls this once Cashfree
  // confirms payment succeeded. The `status: 'pending'` filter makes this
  // safe to call twice (webhook retries, webhook + verify both firing) —
  // the second call simply finds nothing to update and no-ops, so the
  // wallet is never double-credited.
  async confirmRechargeSuccess(cashfreeOrderId: string): Promise<void> {
    const txn = await Transaction.findOneAndUpdate(
      { cashfreeOrderId, type: 'recharge', status: 'pending' },
      { status: 'completed' },
      { new: true }
    );
    if (!txn) return; // already processed, or not a recharge — no-op

    await walletService.getOrCreate(txn.userId);
    await Wallet.findOneAndUpdate({ userId: txn.userId }, { $inc: { balance: txn.amount } });

    await notificationService.create({
      userId:  txn.userId,
      title:   '💰 Wallet Recharged!',
      message: `₹${txn.amount} has been added to your wallet.`,
      type:    'wallet',
    });
  },

  async markRechargeFailed(cashfreeOrderId: string): Promise<void> {
    await Transaction.findOneAndUpdate(
      { cashfreeOrderId, type: 'recharge', status: 'pending' },
      { status: 'failed' }
    );
  },

  // Used when Cashfree order creation itself throws (before a
  // cashfreeOrderId was ever attached) — marks the pending recharge failed
  // by its own _id instead of relying on a cashfreeOrderId lookup.
  async markRechargeInitiationFailed(transactionId: string): Promise<void> {
    await Transaction.findOneAndUpdate(
      { _id: transactionId, type: 'recharge', status: 'pending' },
      { status: 'failed' }
    );
  },

  // For the frontend's verify-on-return fallback — just needs to know
  // whether this recharge belongs to the requesting user and its cashfreeOrderId.
  async getRechargeTransaction(transactionId: string, userId: string) {
    return Transaction.findOne({ _id: transactionId, userId, type: 'recharge' });
  },
};
