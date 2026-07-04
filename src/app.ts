import 'express-async-errors';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import mongoSanitize from 'express-mongo-sanitize';
import { env } from './config/env';
import { errorMiddleware } from './middleware/error.middleware';
import { globalLimiter } from './middleware/rateLimiter.middleware';

import authRoutes         from './routes/auth.routes';
import orderRoutes        from './routes/order.routes';
import userRoutes         from './routes/user.routes';
import walletRoutes       from './routes/wallet.routes';
import withdrawalRoutes   from './routes/withdrawal.routes';
import notificationRoutes from './routes/notification.routes';
import ratingRoutes       from './routes/rating.routes';
import disputeRoutes      from './routes/dispute.routes';
import adminRoutes        from './routes/admin.routes';
import settingsRoutes     from './routes/settings.routes';

export const app = express();

// ── Security headers ────────────────────────────────────────────────────────
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));

// ── CORS ──────────────────────────────────────────────────────────────────────
const allowedOrigins = [
  env.FRONTEND_URL,
  'http://localhost:3000',
  'http://127.0.0.1:3000',
].filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error(`CORS: Origin ${origin} not allowed`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ── NoSQL injection protection ────────────────────────────────────────────────
app.use(mongoSanitize());

// ── Rate limiting (applied to all /api routes) ────────────────────────────────
app.use('/api', globalLimiter);

// ── Health check — Render uses this to detect the server is alive ─────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', environment: env.NODE_ENV, timestamp: new Date().toISOString() });
});

// ── API routes ────────────────────────────────────────────────────────────────
app.use('/api/auth',          authRoutes);
app.use('/api/orders',        orderRoutes);
app.use('/api/users',         userRoutes);
app.use('/api/wallet',        walletRoutes);
app.use('/api/withdrawals',   withdrawalRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/ratings',       ratingRoutes);
app.use('/api/disputes',      disputeRoutes);
app.use('/api/admin',         adminRoutes);
app.use('/api/settings',      settingsRoutes);

// ── 404 ───────────────────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ success: false, message: 'Route not found' });
});

// ── Global error handler (must be last middleware) ────────────────────────────
app.use(errorMiddleware);
