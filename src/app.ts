import 'express-async-errors';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import mongoSanitize from 'express-mongo-sanitize';
import { env } from './config/env';
import { errorMiddleware } from './middleware/error.middleware';
import { handleWebhook } from './controllers/payment.controller';

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
import refundRoutes       from './routes/refund.routes';
import leaderboardRoutes  from './routes/leaderboard.routes';
import paymentRoutes      from './routes/payment.routes';

export const app = express();

// Render sits behind a reverse proxy — without this, req.ip resolves to
// Render's internal proxy address for every request, making IP-based
// features (rate limiting already relies on this too) useless. `1` means
// "trust the first hop" — correct for Render's single-proxy setup.
app.set('trust proxy', 1);

// ── Security headers ────────────────────────────────────────────────────────
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));

// ── CORS ──────────────────────────────────────────────────────────────────────
// FRONTEND_URL can hold multiple comma-separated origins (custom domain,
// www variant, old vercel.app domain, etc.) — this lets us support several
// live frontend domains at once instead of only ever one at a time, and
// avoids the site breaking every time a domain is added/removed.
// Trailing slashes are stripped so a copy-pasted URL with a trailing "/"
// (a common mistake) doesn't silently mismatch the browser's Origin header,
// which never has one.
const allowedOrigins = [
  ...env.FRONTEND_URL.split(',').map((url) => url.trim().replace(/\/$/, '')),
  'https://mailzeon.shop',
  'https://www.mailzeon.shop',
  'https://mailzeon.vercel.app',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
].filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    const normalizedOrigin = origin.replace(/\/$/, '');
    if (allowedOrigins.includes(normalizedOrigin)) return callback(null, true);
    callback(new Error(`CORS: Origin ${origin} not allowed`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// ── Cookie parsing ────────────────────────────────────────────────────────────
// Populates req.cookies — needed so auth.middleware.ts can read the httpOnly
// session cookie set by setAuthCookie() (see utils/cookies.ts). Only reads
// the Cookie request header — doesn't touch the request body — so it's safe
// to mount before or after the raw-body webhook route below either way.
app.use(cookieParser());

// ── Cashfree webhook — CRITICAL ORDERING ──────────────────────────────────────
// Mounted with a raw-body parser BEFORE the global express.json() below.
// Cashfree signs the exact raw bytes of the request body. If express.json()
// parses it first and we later re-derive/re-stringify it for verification,
// the bytes may differ (whitespace, key order) and a legitimate webhook
// would fail signature verification. This route must stay above json().
app.post('/api/payments/webhook', express.raw({ type: '*/*' }), handleWebhook);

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ── NoSQL injection protection ────────────────────────────────────────────────
app.use(mongoSanitize());

// REMOVED (Aug 2026): global /api-wide rate limiting. Even after keying
// by account instead of raw IP, it was still causing genuine customers,
// workers, and admin to hit "Too many requests" / "Failed to load X"
// during completely normal usage — removed at the person's explicit
// request after discussing the tradeoff (this does mean no protection
// against scraping/high-volume abuse at the API layer anymore). The
// auth-specific limiter below (login/register brute-force protection)
// is unrelated and still in place.

// ── Health check — Render uses this to detect the server is alive ─────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', environment: env.NODE_ENV, timestamp: new Date().toISOString() });
});

// ── IP debug — for verifying 'trust proxy' is set to the CORRECT hop count ────
// Shows ONLY the current requester's own connection info, nothing about
// any other user — safe to leave public permanently, same as any
// "what's my IP" endpoint. Exists because getting the hop count wrong in
// EITHER direction silently breaks real things: too low and req.ip
// resolves to a shared Render-internal proxy address (making every rate
// limit / IP-based lock effectively apply to ALL users at once, exactly
// the kind of false-positive this app has already hit); too high and a
// client can forge X-Forwarded-For to spoof any IP they want, defeating
// the whole anti-fraud IP layer. Compare 'req.ip' below against your own
// real public IP (e.g. https://api.ipify.org) — if they don't match,
// adjust app.set('trust proxy', N) above until they do. See the count of
// entries in 'x-forwarded-for' for a second sanity check: with the
// correct hop count, 'req.ip' should equal the FIRST (leftmost) entry.
app.get('/api/_debug/ip', (req, res) => {
  res.json({
    success: true,
    'req.ip': req.ip,
    'req.ips': req.ips,
    'x-forwarded-for (raw header)': req.headers['x-forwarded-for'] ?? null,
    'current trust proxy setting': app.get('trust proxy'),
  });
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
app.use('/api/refunds',       refundRoutes);
app.use('/api/leaderboard',   leaderboardRoutes);
app.use('/api/payments',      paymentRoutes); // GET /verify/:orderId (normal JSON auth route)

// ── 404 ───────────────────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ success: false, message: 'Route not found' });
});

// ── Global error handler (must be last middleware) ────────────────────────────
app.use(errorMiddleware);
