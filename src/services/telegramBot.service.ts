import { env, PRIMARY_FRONTEND_URL } from '../config/env';

// Thin wrapper around Telegram's Bot API sendMessage method:
// https://core.telegram.org/bots/api#sendmessage
// Uses the platform's built-in `fetch` (Node 18+), same pattern as
// utils/phoneVerification.ts / ipIntelligence.ts elsewhere in this
// backend — no need for axios just for this one call.
const TELEGRAM_API_BASE = 'https://api.telegram.org';

export const telegramBotService = {
  // Generic send — this IS now a real notification channel (see
  // notification.service.ts create()), not just the one-off /start
  // welcome message it started as. Telegram's Mini App WebView doesn't
  // support the standard browser Push API/Service Workers at all (it's a
  // sandboxed WebView, not a full installable PWA context) — so without
  // this, a Telegram-origin user gets ZERO notifications whenever the
  // Mini App itself isn't open, unlike web/PWA users who still get push
  // notifications with the site closed. This bot message is the
  // equivalent channel for them.
  //
  // Only ever reaches people who have opened the Mini App / sent /start
  // at least once — Telegram simply won't deliver a bot message to anyone
  // who hasn't started a conversation with the bot, so this can never be
  // used to message an arbitrary stranger.
  async sendMessage(chatId: number | string, text: string, includeOpenAppButton = true): Promise<void> {
    if (!env.TELEGRAM_BOT_TOKEN) {
      console.error('[TelegramBot] Cannot send message — TELEGRAM_BOT_TOKEN not configured.');
      return;
    }

    const url = `${TELEGRAM_API_BASE}/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
    const body: Record<string, unknown> = { chat_id: chatId, text };
    if (includeOpenAppButton) {
      body.reply_markup = {
        inline_keyboard: [[
          { text: '🚀 Open Mailzeon', web_app: { url: `${PRIMARY_FRONTEND_URL}/telegram` } },
        ]],
      };
    }

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) {
        console.error('[TelegramBot] sendMessage failed:', res.status, await res.text());
      }
    } catch (err) {
      // Never let a failed Telegram API call break whatever real action
      // triggered this notification (order accepted, wallet credited,
      // etc.) — worst case, this one side-channel silently doesn't
      // deliver, same fire-and-forget philosophy as web-push/email.
      console.error('[TelegramBot] sendMessage request failed:', err);
    }
  },

  // Sends the "tap below to open the app" welcome message — the reply to
  // /start specifically. Everything else this bot ever sends goes through
  // sendMessage() above instead.
  async sendWelcomeMessage(chatId: number): Promise<void> {
    await telegramBotService.sendMessage(
      chatId,
      '👋 Welcome to Mailzeon!\n\n' +
      'Order email accounts, track your orders, or fulfill orders and earn — all from right here in Telegram.\n\n' +
      'Tap the button below to get started.'
    );
  },
};
