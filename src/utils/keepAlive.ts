/**
 * keepAlive.ts
 *
 * Render's free tier spins the server down after 15 minutes of inactivity.
 * This utility self-pings the /health endpoint every 10 minutes to keep
 * the server awake — so Socket.IO connections and in-memory order timers
 * stay alive instead of being destroyed on every cold start.
 *
 * Render automatically provides RENDER_EXTERNAL_URL for web services —
 * no manual environment variable setup is required. If this variable is
 * absent (e.g. running locally), the ping is silently skipped.
 */

const PING_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

export const startKeepAlive = (): void => {
  // Render sets this automatically. KEEP_ALIVE_URL is a manual override/fallback.
  const baseUrl = process.env.RENDER_EXTERNAL_URL || process.env.KEEP_ALIVE_URL;

  if (!baseUrl) {
    console.log('ℹ️  Keep-alive skipped (no RENDER_EXTERNAL_URL — likely local dev)');
    return;
  }

  const healthUrl = `${baseUrl.replace(/\/$/, '')}/health`;
  console.log(`🏓 Keep-alive started → pinging ${healthUrl} every 10 min`);

  setInterval(async () => {
    try {
      const res = await fetch(healthUrl, {
        method: 'GET',
        signal: AbortSignal.timeout(10000), // 10s timeout
      });
      if (!res.ok) {
        console.warn(`[KeepAlive] Ping returned status ${res.status}`);
      }
    } catch (err) {
      // Non-fatal — log and continue, don't crash the server over a failed ping
      console.warn('[KeepAlive] Ping failed:', (err as Error).message);
    }
  }, PING_INTERVAL_MS);
};
