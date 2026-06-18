import { Rating } from '../models/Rating.model';
import { Order } from '../models/Order.model';
import { WorkerLevelModel } from '../models/WorkerLevel.model';
import { User } from '../models/User.model';

export const workerLevelService = {
  async recalculate(workerId: string): Promise<void> {
    const [ratings, completedOrders, totalOrders] = await Promise.all([
      Rating.find({ workerId }),
      Order.countDocuments({ workerId, status: 'completed' }),
      Order.countDocuments({ workerId, status: { $in: ['completed', 'under_review', 'cancelled'] } }),
    ]);

    const avgRating   = ratings.length ? ratings.reduce((s, r) => s + r.rating, 0) / ratings.length : 0;
    const successRate = totalOrders ? Math.round((completedOrders / totalOrders) * 100) : 100;

    // Level thresholds
    let level: 'bronze' | 'silver' | 'gold' = 'bronze';
    if (completedOrders >= 50 && successRate >= 90 && avgRating >= 4.0) level = 'gold';
    else if (completedOrders >= 10 && successRate >= 80) level = 'silver';

    await Promise.all([
      WorkerLevelModel.findOneAndUpdate(
        { workerId },
        { level, completedOrders, successRate, averageRating: parseFloat(avgRating.toFixed(1)) },
        { upsert: true, new: true }
      ),
      User.findByIdAndUpdate(workerId, { level }),
    ]);
  },
};
