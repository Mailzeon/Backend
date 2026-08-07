import { Server as SocketIOServer } from 'socket.io';
import { Server as HttpServer }     from 'http';
import { env }                      from '../config/env';
import { User }                     from '../models/User.model';

let io: SocketIOServer;

export const initSocket = (server: HttpServer): SocketIOServer => {
  const allowedOrigins = [
    env.FRONTEND_URL,
    'http://localhost:3000',
    'http://127.0.0.1:3000',
  ].filter(Boolean);

  io = new SocketIOServer(server, {
    cors: {
      origin:      allowedOrigins,
      methods:     ['GET', 'POST'],
      credentials: true,
    },
    // Keep connections alive on Render free tier
    pingTimeout:  60000,
    pingInterval: 25000,
    // Allow both WebSocket and polling (polling fallback needed on some deployments)
    transports: ['websocket', 'polling'],
  });

  io.on('connection', (socket) => {
    // Every user joins their own private room on login
    socket.on('join-room', async (userId: string) => {
      if (!userId || typeof userId !== 'string') return;
      // Remembered so 'disconnect' below can tell whose connection just
      // dropped, without trusting anything the client sends at that point.
      socket.data.userId = userId;
      socket.join(`user:${userId}`);

      // A worker's toggle is their own PREFERENCE, stored as-is in the DB —
      // it's intentionally never touched by connect/disconnect. What admins
      // see live is "prefers online AND is actually reachable right now",
      // recomputed on every reconnect. This is what makes a worker's own
      // toggle already show ON the moment they reopen the app after losing
      // connection — nothing to manually re-flip — while the admin's count
      // still only counts workers who are genuinely online this second.
      try {
        const user = await User.findById(userId).select('role isOnline').lean();
        if (user?.role === 'worker' && user.isOnline) {
          await pushLiveWorkerCount();
        }
      } catch (err) {
        console.error('[Socket] Failed to refresh worker count on join:', err);
      }
    });

    // Approved online workers join the marketplace broadcast room
    socket.on('join-marketplace', () => {
      socket.join('marketplace');
    });

    // Admins join a shared 'admin' room to receive live platform stat
    // updates (e.g. worker online/offline count) without needing to
    // refresh or poll.
    socket.on('join-admin', () => {
      socket.join('admin');
    });

    socket.on('leave-marketplace', () => {
      socket.leave('marketplace');
    });

    socket.on('disconnect', async () => {
      // NOTE: this does NOT touch the worker's isOnline DB flag anymore —
      // that field is purely their own preference now. This only affects
      // what admins see LIVE: as soon as a worker's last active connection
      // drops (app closed, tab died, internet lost — anything other than
      // them flipping their own switch), the admin's count drops
      // immediately, without waiting for them to explicitly go offline.
      const userId = socket.data.userId as string | undefined;
      if (!userId) return;

      // A user can have more than one tab/device connected at once (each
      // gets its own socket, all joined to the same `user:<id>` room) — only
      // act once NONE of their connections remain.
      const room = io.sockets.adapter.rooms.get(`user:${userId}`);
      if (room && room.size > 0) return;

      try {
        const user = await User.findById(userId).select('role isOnline').lean();
        if (user?.role === 'worker' && user.isOnline) {
          await pushLiveWorkerCount();
        }
      } catch (err) {
        console.error('[Socket] Failed to refresh worker count on disconnect:', err);
      }
    });
  });

  return io;
};

export const getIO = (): SocketIOServer => {
  if (!io) throw new Error('Socket.IO not initialized. Call initSocket first.');
  return io;
};

// ── Live "Workers Online" count ──────────────────────────────────────────
// A worker only counts as genuinely online when BOTH are true:
//   1. isOnline === true in the DB (their own toggle preference)
//   2. they currently have at least one live socket connection
// This is what makes the admin's number track real presence exactly —
// closing the app drops the count immediately even though isOnline in the
// DB still says true, and reopening the app restores it immediately with
// no action needed from the worker.
export const computeLiveOnlineWorkerCount = async (): Promise<number> => {
  const onlineWorkers = await User.find({ role: 'worker', isOnline: true }).select('_id').lean();
  let liveCount = 0;
  for (const w of onlineWorkers) {
    const room = io.sockets.adapter.rooms.get(`user:${w._id.toString()}`);
    if (room && room.size > 0) liveCount++;
  }
  return liveCount;
};

/** Recompute the live count and push it to every connected admin. */
export const pushLiveWorkerCount = async (): Promise<number> => {
  const onlineWorkers = await computeLiveOnlineWorkerCount();
  io.to('admin').emit('worker-online-count-changed', { onlineWorkers });
  return onlineWorkers;
};
