import { getBooleanEnv, jsonResponse } from "./env";
import { checkRateLimit } from "./rate-limit";
import { readMonitorState } from "./state";
import { unsubscribeChat, upsertSubscription } from "./subscriptions";
import {
  formatStatusMessage,
  editTelegramMessage,
  getTelegramCommandReplyMarkup,
  parseAdminTelegramChatIds,
  sendTelegramChatAction,
  sendTelegramMessage,
  truncateForTelegram,
} from "./telegram";
import type { Env } from "./types";

const MAX_WEBHOOK_BODY_BYTES = 64 * 1024;
const UPDATE_DEDUPE_TTL_SECONDS = 24 * 60 * 60;

type TelegramChat = {
  id: number | string;
  type?: string;
};

type TelegramMessage = {
  message_id?: number;
  text?: string;
  chat?: TelegramChat;
};

type TelegramUpdate = {
  update_id?: number;
  message?: TelegramMessage;
};

const getWebhookSecret = (env: Env): string => env.TELEGRAM_WEBHOOK_SECRET?.trim() || "";

const safeReply = async (env: Env, chatId: string, text: string): Promise<void> => {
  try {
    await sendTelegramMessage(env, chatId, truncateForTelegram(text), undefined, {
      replyMarkup: getTelegramCommandReplyMarkup(),
    });
  } catch (_error) {
    // Webhook handlers should acknowledge Telegram even when outbound replies fail.
  }
};

const sendProgressThenFinal = async (
  env: Env,
  chatId: string,
  progressText: string,
  getFinalText: () => Promise<string>,
): Promise<void> => {
  const progress = await sendTelegramMessage(env, chatId, progressText, undefined, {
    replyMarkup: getTelegramCommandReplyMarkup(),
  });
  const finalText = await getFinalText();

  if (progress.ok && typeof progress.messageId === "number") {
    const edited = await editTelegramMessage(env, chatId, progress.messageId, finalText);

    if (edited.ok) {
      return;
    }
  }

  await safeReply(env, chatId, finalText);
};

const getCommandName = (text: string): string => {
  const firstToken = text.trim().split(/\s+/)[0] || "";
  return firstToken.split("@")[0].toLowerCase();
};

const dedupeUpdate = async (env: Env, updateId: number | undefined): Promise<boolean> => {
  if (typeof updateId !== "number") {
    return false;
  }

  const key = `telegram-update:${updateId}`;
  const existing = await env.MONITOR_STATE.get(key);

  if (existing) {
    return true;
  }

  await env.MONITOR_STATE.put(key, "1", { expirationTtl: UPDATE_DEDUPE_TTL_SECONDS });
  return false;
};

const readWebhookUpdate = async (request: Request): Promise<TelegramUpdate | null> => {
  const contentLength = Number(request.headers.get("content-length") || 0);

  if (Number.isFinite(contentLength) && contentLength > MAX_WEBHOOK_BODY_BYTES) {
    throw new Response("Payload too large", { status: 413 });
  }

  const raw = await request.text();

  if (raw.length > MAX_WEBHOOK_BODY_BYTES) {
    throw new Response("Payload too large", { status: 413 });
  }

  try {
    return JSON.parse(raw) as TelegramUpdate;
  } catch (_error) {
    return null;
  }
};

const isAdminChat = (env: Env, chatId: string): boolean => parseAdminTelegramChatIds(env).includes(chatId);

const safeTyping = async (env: Env, chatId: string): Promise<void> => {
  try {
    await sendTelegramChatAction(env, chatId);
  } catch (_error) {
    // Chat actions are best-effort user feedback; never block command handling.
  }
};

const handleCommand = async (env: Env, chatId: string, chatType: string, command: string): Promise<void> => {
  await safeTyping(env, chatId);

  if (command === "/start" || command === "/help") {
    await safeReply(
      env,
      chatId,
      [
        "Codex limit tweet monitor",
        "",
        "I silently cache monitored tweets and only send subscriber alerts when a reset is confirmed. Use /status to see the latest cached tweet.",
        "",
        "Commands:",
        "/status - show latest cached tweet and monitor status",
        "/subscribe - receive future reset alerts when public subscriptions are enabled",
        "/unsubscribe - stop receiving alerts",
      ].join("\n"),
    );
    return;
  }

  if (command === "/status" || command === "/last") {
    await sendProgressThenFinal(env, chatId, "Checking cached monitor status...", async () => {
      const state = await readMonitorState(env.MONITOR_STATE);
      return formatStatusMessage(state);
    });
    return;
  }

  if (command === "/subscribe") {
    await sendProgressThenFinal(env, chatId, "Subscribing this chat...", async () => {
      if (!getBooleanEnv(env.PUBLIC_SUBSCRIPTIONS_ENABLED)) {
        return "Public subscriptions are not enabled for this bot yet.";
      }

      await upsertSubscription(env, chatId, chatType);
      return "Subscribed. You will receive future reset alerts.";
    });
    return;
  }

  if (command === "/unsubscribe") {
    await sendProgressThenFinal(env, chatId, "Unsubscribing this chat...", async () => {
      if (!getBooleanEnv(env.PUBLIC_SUBSCRIPTIONS_ENABLED)) {
        return "Public subscriptions are not enabled for this bot yet.";
      }

      await unsubscribeChat(env, chatId);
      return "Unsubscribed.";
    });
    return;
  }

  if (command === "/run") {
    await safeReply(
      env,
      chatId,
      isAdminChat(env, chatId)
        ? "Manual runs must use authenticated HTTP POST /run. Telegram commands cannot trigger expensive monitor runs."
        : "Manual runs are admin-only.",
    );
  }
};

export const handleTelegramWebhook = async (request: Request, env: Env): Promise<Response> => {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const webhookSecret = getWebhookSecret(env);

  if (!webhookSecret) {
    return new Response("Telegram webhook disabled", { status: 404 });
  }

  if (request.headers.get("x-telegram-bot-api-secret-token") !== webhookSecret) {
    return new Response("Unauthorized", { status: 401 });
  }

  let update: TelegramUpdate | null;

  try {
    update = await readWebhookUpdate(request);
  } catch (error) {
    if (error instanceof Response) {
      return error;
    }

    return jsonResponse({ ok: true, ignored: true });
  }

  if (!update) {
    return jsonResponse({ ok: true, ignored: true });
  }

  const message = update.message;
  const chatId = message?.chat?.id == null ? "" : String(message.chat.id);
  const chatType = message?.chat?.type || "private";
  const text = typeof message?.text === "string" ? message.text.trim() : "";

  if (!chatId || !text.startsWith("/")) {
    return jsonResponse({ ok: true, ignored: true });
  }

  const globalLimit = await checkRateLimit(env, "telegram:webhook:global", 300, 60);

  if (!globalLimit.allowed) {
    return jsonResponse({ ok: true, rateLimited: true });
  }

  const chatLimit = await checkRateLimit(env, `telegram:webhook:chat:${chatId}`, 20, 60);

  if (!chatLimit.allowed) {
    return jsonResponse({ ok: true, rateLimited: true });
  }

  if (await dedupeUpdate(env, update.update_id)) {
    return jsonResponse({ ok: true, duplicate: true });
  }

  await handleCommand(env, chatId, chatType, getCommandName(text));

  return jsonResponse({ ok: true });
};
