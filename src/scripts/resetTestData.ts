/**
 * ONE-TIME reset script — clears all order/activity/earnings data so
 * existing accounts look exactly like they did right after signup, with
 * zero history. User accounts themselves (name, email, password, role,
 * approval status, profile picture) are left completely untouched, as are
 * Settings and push notification subscriptions.
 *
 * Run this ONCE from Render's Shell tab (Backend service → Shell) after
 * deploying, with:
 *
 *   node dist/scripts/resetTestData.js
 *
 * This does NOT run automatically on server startup — it's a standalone
 * script you run manually, on purpose, exactly one time.
 *
 * ⚠️  THIS IS IRREVERSIBLE. Double-check you actually want to wipe all
 * orders/disputes/refunds/withdrawals/transactions/notifications/ratings
 * before running it — there is no undo.
 */
import mongoose from 'mongoose';
import { env } from '../config/env';
import { Order }          from '../models/Order.model';
import { Dispute }        from '../models/Dispute.model';
import { RefundRequest }  from '../models/RefundRequest.model';
import { WithdrawRequest } from '../models/WithdrawRequest.model';
import { Transaction }    from '../models/Transaction.model';
import { Notification }   from '../models/Notification.model';
import { Rating }         from '../models/Rating.model';
import { Wallet }         from '../models/Wallet.model';
import { WorkerLevelModel } from '../models/WorkerLevel.model';

const run = async () => {
  console.log('Connecting to MongoDB...');
  await mongoose.connect(env.MONGODB_URI);
  console.log(`Connected: ${mongoose.connection.name}\n`);

  // Delete everything that represents order activity / history — this is
  // the "as if nothing has happened yet" reset.
  const [orders, disputes, refunds, withdrawals, transactions, notifications, ratings] =
    await Promise.all([
      Order.deleteMany({}),
      Dispute.deleteMany({}),
      RefundRequest.deleteMany({}),
      WithdrawRequest.deleteMany({}),
      Transaction.deleteMany({}),
      Notification.deleteMany({}),
      Rating.deleteMany({}),
    ]);

  // Reset earnings/stats back to zero instead of deleting the documents —
  // keeps the same Wallet/WorkerLevel row per user (avoids any code path
  // that assumes one already exists for an approved worker), just blanked out.
  const walletReset = await Wallet.updateMany(
    {},
    { $set: { balance: 0, pendingBalance: 0, totalEarned: 0 } }
  );
  const levelReset = await WorkerLevelModel.updateMany(
    {},
    { $set: { level: 'bronze', completedOrders: 0, totalEarnings: 0, successRate: 100, averageRating: 0 } }
  );

  console.log('✅ Reset complete:');
  console.log(`   Orders deleted:        ${orders.deletedCount}`);
  console.log(`   Disputes deleted:      ${disputes.deletedCount}`);
  console.log(`   Refund requests:       ${refunds.deletedCount}`);
  console.log(`   Withdraw requests:     ${withdrawals.deletedCount}`);
  console.log(`   Transactions deleted:  ${transactions.deletedCount}`);
  console.log(`   Notifications deleted: ${notifications.deletedCount}`);
  console.log(`   Ratings deleted:       ${ratings.deletedCount}`);
  console.log(`   Wallets reset to ₹0:   ${walletReset.modifiedCount}`);
  console.log(`   Worker levels reset:   ${levelReset.modifiedCount}`);
  console.log('\nUser accounts, Settings, and push subscriptions were left untouched.');

  await mongoose.disconnect();
  process.exit(0);
};

run().catch((err) => {
  console.error('❌ Reset script failed:', err);
  process.exit(1);
});
