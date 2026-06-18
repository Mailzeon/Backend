import { Server as SocketIOServer } from 'socket.io';
import { Server as HttpServer }     from 'http';
import { env }                      from '../config/env';

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
      socket.join(`user:${userId}`);
    });

    // Approved online workers join the marketplace broadcast room
    socket.on('join-marketplace', () => {
      socket.join('marketplace');
    });

    socket.on('leave-marketplace', () => {
      socket.leave('marketplace');
    });

    socket.on('disconnect', () => {
      // Rooms are automatically left on disconnect — no cleanup needed
    });
  });

  return io;
};

export const getIO = (): SocketIOServer => {
  if (!io) throw new Error('Socket.IO not initialized. Call initSocket first.');
  return io;
};
