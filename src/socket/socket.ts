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
    socket.on('join-room', (userId: string) => {
      if (!userId || typeof userId !== 'string') return;
      // Remembered so 'disconnect' below can tell whose connection just
      // dropped, without trusting anything the client sends at that point.
      socket.data.userId = userId;
      socket.join(`user:${userId}`);
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
      // Safety net for the "Workers Online" count staying truly accurate:
      // if a worker force-closes the app, loses internet, or their tab just
      // dies — anything other than deliberately flipping their own
      // online/offline switch — their isOnline flag would otherwise stay
      // stuck 'true' forever with no way to correct itself. As soon as
      // their LAST active connection drops, flip them back to offline and
      // push the corrected count to admins, same as the deliberate toggle.
      const userId = socket.data.userId as string | undefined;
      if (!userId) return;

      // A user can have more than one tab/device connected at once (each
      // gets its own socket, all joined to the same `user:<id>` room) — only
      // act once NONE of their connections remain.
      const room = io.sockets.adapter.rooms.get(`user:${userId}`);
      if (room && room.size > 0) return;

      try {
        const user = await User.findOneAndUpdate(
          { _id: userId, role: 'worker', isOnline: true },
          { isOnline: false },
          { new: true }
        );
        if (user) {
          const onlineWorkers = await User.countDocuments({ role: 'worker', isOnline: true });
          io.to('admin').emit('worker-online-count-changed', { onlineWorkers });
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
