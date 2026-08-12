import { Server as SocketIOServer } from 'socket.io';
import { Server as HttpServer }     from 'http';
import { env }                      from '../config/env';
import { User }                     from '../models/User.model';

let io: SocketIOServer;

export const initSocket = (server: HttpServer): SocketIOServer => {
  // Same multi-origin list as app.ts's HTTP CORS — kept in sync so
  // WebSocket connections work from every live frontend domain too.
  const allowedOrigins = [
    ...env.FRONTEND_URL.split(',').map((url) => url.trim().replace(/\/$/, '')),
    'https://mailzeon.shop',
    'https://www.mailzeon.shop',
    'https://mailzeon.vercel.app',
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

      // No manual toggle anymore — a worker is simply "online" for as long
      // as they have the site open. Being here IS the signal; there's
      // nothing else to check or ask them to flip.
      try {
        const user = await User.findById(userId).select('role isOnline').lean();
        if (user?.role === 'worker' && !user.isOnline) {
          await User.findByIdAndUpdate(userId, { isOnline: true });
        }
        if (user?.role === 'worker') {
          await pushLiveWorkerCount();
        }
      } catch (err) {
        console.error('[Socket] Failed to mark worker online on join:', err);
      }
    });

    // Every connected worker automatically joins the marketplace broadcast
    // room too (see lib/socket.ts initSocket — emitted right alongside
    // join-room on every connect) — no separate opt-in needed.
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
      // As soon as a worker's LAST active connection drops — app closed,
      // tab died, internet lost, whatever — they go offline automatically.
      // No toggle to leave in the wrong position, nothing to remember to
      // flip back on next time; reconnecting (the join-room handler above)
      // brings them straight back online with zero action needed.
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
          await User.findByIdAndUpdate(userId, { isOnline: false });
          await pushLiveWorkerCount();
        }
      } catch (err) {
        console.error('[Socket] Failed to mark worker offline on disconnect:', err);
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
// isOnline is now fully automatic (set on connect, cleared on the last
// disconnect — see above), so in the normal case it already IS the live
// count. The socket-room cross-check below is kept purely as a safety net
// for the one scenario automatic tracking can't self-heal from — the
// server process itself restarting/crashing without every socket getting
// a clean 'disconnect' event first, which could otherwise leave a worker
// stuck showing isOnline: true with no live connection at all.
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
