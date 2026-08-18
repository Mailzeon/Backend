import { OrderHistory, IOrderHistory, OrderHistoryEvent } from '../models/OrderHistory.model';

export const orderHistoryService = {
  // Fire-and-forget by design (caught internally, never thrown) — logging
  // a history entry must NEVER be able to break the actual order flow
  // it's describing. If this insert fails, the order still completes/
  // cancels/etc. normally; only the audit trail for that one event is
  // missing, which is far preferable to blocking real money/state changes
  // over a logging hiccup.
  async log(
    orderId: string,
    event: OrderHistoryEvent,
    opts: {
      actorId?: string;
      actorRole?: 'customer' | 'worker' | 'admin' | 'system';
      message: string;
      metadata?: Record<string, unknown>;
    }
  ): Promise<void> {
    try {
      await OrderHistory.create({
        orderId,
        event,
        actorId: opts.actorId,
        actorRole: opts.actorRole,
        message: opts.message,
        metadata: opts.metadata,
      });
    } catch (err) {
      console.error(`[OrderHistory] Failed to log '${event}' for order ${orderId}:`, err);
    }
  },

  // Full chronological timeline for one order — oldest first, so it reads
  // top-to-bottom like a story ("Ramu accepted → timer expired → Chintu
  // accepted → confirmed theft, banned → refunded").
  async getForOrder(orderId: string): Promise<IOrderHistory[]> {
    return OrderHistory.find({ orderId })
      .sort({ createdAt: 1 })
      .populate('actorId', 'name email role');
  },
};
