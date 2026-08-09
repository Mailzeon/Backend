import { getIO } from './socket';

// ─── Event name constants ─────────────────────────────────────────────────────
// Using constants prevents typos across the codebase.
// The frontend must use the exact same names.

export const EVENTS = {
  // Order lifecycle
  NEW_ORDER:         'new-order',          // → marketplace room (all online workers)
  ORDER_ACCEPTED:    'order-accepted',     // → customer's room
  CREDENTIALS_READY: 'credentials-ready', // → customer's room
  ORDER_COMPLETED:   'order-completed',   // → customer + worker rooms
  ORDER_CANCELLED:   'order-cancelled',   // → customer's room

  // Verification number flow (Google "new device login" style)
  NUMBER_SUBMITTED:  'number-submitted',   // → worker's room (customer submitted the number they see)
  NUMBER_CONFIRMED:  'number-confirmed',   // → customer's room (worker confirmed selecting it)
  CODE_REQUESTED:    'code-requested',     // → worker's room (customer needs an actual code instead)
  CODE_RECEIVED:     'code-received',      // → customer's room (worker sent the code)

  // Wallet & admin
  WITHDRAWAL_DONE:   'withdrawal-done',    // → worker's room
  WORKER_APPROVED:   'worker-approved',    // → worker's room
  WORKER_SUSPENDED:  'worker-suspended',   // → worker's room

  // Live admin dashboard stats
  WORKER_ONLINE_COUNT_CHANGED: 'worker-online-count-changed', // → admin room

  // Generic push notification
  NOTIFICATION:      'notification',       // → any user's room
} as const;

// ─── Emitter helpers ──────────────────────────────────────────────────────────

/** Send an event to a single user's private room. */
export const emitToUser = (userId: string, event: string, data: unknown): void => {
  getIO().to(`user:${userId}`).emit(event, data);
};

/** Broadcast a new order to all workers currently in the marketplace room. */
export const emitToMarketplace = (event: string, data: unknown): void => {
  getIO().to('marketplace').emit(event, data);
};

/** Broadcast to every connected client (use sparingly). */
export const emitToAll = (event: string, data: unknown): void => {
  getIO().emit(event, data);
};

/** Send an event to every connected admin (see 'join-admin' in socket.ts). */
export const emitToAdmins = (event: string, data: unknown): void => {
  getIO().to('admin').emit(event, data);
};
