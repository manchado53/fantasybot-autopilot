import { fileURLToPath } from "node:url";
import { loadConfig, loadTelegramCursor, saveTelegramCursor } from "../state/store.js";
import type { BotConfig } from "../types.js";

function api(config: BotConfig, method: string) {
  return `https://api.telegram.org/bot${config.telegram.botToken}/${method}`;
}

export interface InlineButton {
  text: string;
  callbackData: string;
}

/**
 * Send a plain message, optionally with inline buttons. `buttonRows` is a
 * list of rows — e.g. `[[approve, reject]]` packs Approve/Reject side by
 * side on one row (single-decision cards), while a shortlist with N
 * independent decisions passes N single-button rows (`[[a], [b], [c]]`) so
 * each stays a distinct, clearly-tappable target rather than a cramped grid.
 */
export async function sendMessage(config: BotConfig, text: string, buttonRows?: InlineButton[][]): Promise<number> {
  const body: Record<string, unknown> = {
    chat_id: config.telegram.chatId,
    text,
    parse_mode: "Markdown",
  };
  if (buttonRows?.length) {
    body.reply_markup = {
      inline_keyboard: buttonRows.map((row) => row.map((b) => ({ text: b.text, callback_data: b.callbackData }))),
    };
  }
  const res = await fetch(api(config, "sendMessage"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Telegram sendMessage failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as any;
  return data.result.message_id;
}

export interface TappedButton {
  callbackData: string;
  messageId: number;
  callbackQueryId: string;
}

/**
 * Poll for any button taps since the last check. Call this once per routine run
 * (every hour) — Telegram has no push webhook wired up here, so this is how the
 * bot notices you tapped Approve/Reject.
 */
export async function pollButtonTaps(config: BotConfig): Promise<TappedButton[]> {
  const cursor = await loadTelegramCursor();
  const res = await fetch(api(config, "getUpdates") + `?offset=${cursor.lastUpdateId + 1}&timeout=0`);
  if (!res.ok) throw new Error(`Telegram getUpdates failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as any;
  const updates: any[] = data.result ?? [];

  const taps: TappedButton[] = [];
  let maxUpdateId = cursor.lastUpdateId;
  for (const update of updates) {
    maxUpdateId = Math.max(maxUpdateId, update.update_id);
    if (update.callback_query) {
      taps.push({
        callbackData: update.callback_query.data,
        messageId: update.callback_query.message.message_id,
        callbackQueryId: update.callback_query.id,
      });
    }
  }
  if (maxUpdateId !== cursor.lastUpdateId) {
    await saveTelegramCursor({ lastUpdateId: maxUpdateId });
  }
  return taps;
}

/**
 * Send text with NO parse_mode. The autopilot's reports are free text written
 * by Claude and quote ESPN error codes like TRAN_ROSTER_SAME_SLOT — under
 * Markdown, one stray `_` or `*` makes Telegram 400 the whole message and
 * the report is lost. Plain text can't fail that way. Long text is split
 * because Telegram caps a message at 4096 chars.
 */
export async function sendPlain(config: BotConfig, text: string): Promise<void> {
  const chunks = text.match(/[\s\S]{1,4000}/g) ?? [""];
  for (const chunk of chunks) {
    const res = await fetch(api(config, "sendMessage"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: config.telegram.chatId, text: chunk }),
    });
    if (!res.ok) throw new Error(`Telegram sendMessage failed: ${res.status} ${await res.text()}`);
  }
}

export interface InboxMessage {
  text: string;
  date: string;
}

/**
 * New text messages from the owner's chat since the last check. Advances the
 * same cursor pollButtonTaps uses — fine because the autopilot replaced the
 * tap flow. Messages from any OTHER chat are ignored on purpose: anyone can
 * message a Telegram bot, and only the owner's chat may steer the autopilot.
 */
export async function readInbox(config: BotConfig): Promise<InboxMessage[]> {
  const cursor = await loadTelegramCursor();
  const res = await fetch(api(config, "getUpdates") + `?offset=${cursor.lastUpdateId + 1}&timeout=0`);
  if (!res.ok) throw new Error(`Telegram getUpdates failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as any;
  const updates: any[] = data.result ?? [];

  const messages: InboxMessage[] = [];
  let maxUpdateId = cursor.lastUpdateId;
  for (const update of updates) {
    maxUpdateId = Math.max(maxUpdateId, update.update_id);
    const msg = update.message;
    if (msg?.text && String(msg.chat?.id) === String(config.telegram.chatId)) {
      messages.push({ text: msg.text, date: new Date(msg.date * 1000).toISOString() });
    }
  }
  if (maxUpdateId !== cursor.lastUpdateId) {
    await saveTelegramCursor({ lastUpdateId: maxUpdateId });
  }
  return messages;
}

/** Acknowledge a button tap so Telegram stops showing a loading spinner on it. */
export async function acknowledgeTap(config: BotConfig, callbackQueryId: string, text?: string): Promise<void> {
  await fetch(api(config, "answerCallbackQuery"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
  });
}

// Run directly (`npm run telegram:test`) to send a one-off test message.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const config = await loadConfig();
  const id = await sendMessage(config, "FantasyBot test message — wiring works.", [
    [{ text: "OK", callbackData: "test:ack" }],
  ]);
  console.log(`Sent test message, id ${id}. Tap the button, then run this again to confirm pollButtonTaps sees it.`);
}
