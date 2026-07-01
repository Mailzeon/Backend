import { Rating }          from '../models/Rating.model';
import { Order }           from '../models/Order.model';
import { Wallet }          from '../models/Wallet.model';
import { WorkerLevelModel } from '../models/WorkerLevel.model';
import { User }            from '../models/User.model';

/**
 * Level thresholds:
 *   Bronze → Silver : 10+ completed orders AND success rate ≥ 80%
 *   Silver → Gold   : 50+ completed orders AND success rate ≥ 90% AND avg rating ≥ 4.0
 */
export const workerLevelService = {
  async recalculate(workerId: string): Promise<void> {
    const [ratings, completedOrders, totalOrders, wallet] = await Promise.all([
      Rating.find({ workerId }),
      Order.countDocuments({ workerId, status: 'completed' }),
      Order.countDocuments({
        workerId,
        status: { $in: ['completed', 'under_review', 'cancelled'] },
      }),
      // FIX: Get real totalEarned from wallet — this field was always 0
      // before because nothing ever populated it on the WorkerLevel doc.
      Wallet.findOne({ userId: workerId }).select('totalEarned').lean(),
    ]);

    const avgRating = ratings.length
      ? ratings.reduce((sum, r) => sum + r.rating, 0) / ratings.length
      : 0;

    const successRate = totalOrders > 0
      ? Math.round((completedOrders / totalOrders) * 100)
      : 100; // 100% by default when no orders yet

    // Determine level
    let level: 'bronze' | 'silver' | 'gold' = 'bronze';
    if (completedOrders >= 50 && successRate >= 90 && avgRating >= 4.0) {
      level = 'gold';
    } else if (completedOrders >= 10 && successRate >= 80) {
      level = 'silver';
    }

    const totalEarnings    = wallet?.totalEarned ?? 0;
    const avgRatingRounded = parseFloat(avgRating.toFixed(1));

    // Update WorkerLevel document
    await WorkerLevelModel.findOneAndUpdate(
      { workerId },
      {
        level,
        completedOrders,
        totalEarnings,   // FIX: now correctly pulled from wallet
        successRate,
        averageRating: avgRatingRounded,
      },
      { upsert: true, new: true }
    );

    // Sync the level field on the User document as well
    await User.findByIdAndUpdate(workerId, { level });
  },
};
