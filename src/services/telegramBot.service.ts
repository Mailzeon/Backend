import { env, PRIMARY_FRONTEND_URL } from '../config/env';

// Thin wrapper around Telegram's Bot API sendMessage method:
// https://core.telegram.org/bots/api#sendmessage
// Uses the platform's built-in `fetch` (Node 18+), same pattern as
// utils/phoneVerification.ts / ipIntelligence.ts elsewhere in this
// backend — no need for axios just for this one call.
const TELEGRAM_API_BASE = 'https://api.telegram.org';

export const telegramBotService = {
  // Sends the "tap below to open the app" welcome message — the ONLY
  // message this bot ever sends. There's no broader conversational bot
  // here by design; this webhook exists purely to make /start feel
  // complete, not to build out a full chatbot.
  async sendWelcomeMessage(chatId: number): Promise<void> {
    if (!env.TELEGRAM_BOT_TOKEN) {
      console.error('[TelegramBot] Cannot send welcome message — TELEGRAM_BOT_TOKEN not configured.');
      return;
    }

    const url = `${TELEGRAM_API_BASE}/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
    const body = {
      chat_id: chatId,
      text:
        '👋 Welcome to Mailzeon!\n\n' +
        'Order email accounts, track your orders, or fulfill orders and earn — all from right here in Telegram.\n\n' +
        'Tap the button below to get started.',
      reply_markup: {
        inline_keyboard: [[
          {
            text: '🚀 Open Mailzeon',
            // web_app buttons are the one inline-keyboard button type that
            // opens a Mini App directly inside Telegram (as opposed to a
            // plain `url` button, which would just open this in an
            // external browser and lose the whole point of a Mini App).
            web_app: { url: `${PRIMARY_FRONTEND_URL}/telegram` },
          },
        ]],
      },
    };

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
      // Never let a failed Telegram API call take down the webhook
      // handler — worst case, the user just doesn't get the welcome
      // message and falls back to the menu button, which works
      // independently of this.
      console.error('[TelegramBot] sendMessage request failed:', err);
    }
  },
};
