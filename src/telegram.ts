import { splitCsv } from "./env";
import type { Classification, Env, MonitorState, Tweet } from "./types";

const TELEGRAM_MESSAGE_LIMIT = 4096;
const SAFE_MESSAGE_LIMIT = 3900;

export const TELEGRAM_COMMANDS = [
  { command: "status", description: "Show the latest cached tweet and monitor status" },
  { command: "subscribe", description: "Receive reset alerts" },
  { command: "unsubscribe", description: "Stop reset alerts" },
  { command: "help", description: "Show bot help" },
];

export type TelegramMessageOptions = {
  disableWebPagePreview?: boolean;
  replyMarkup?: unknown;
};

export type TelegramSendResult =
  | {
      ok: true;
      status: number;
      messageId?: number;
    }
  | {
      ok: false;
      status: number;
      error: string;
      retryable: boolean;
      permanent: boolean;
    };

export const parseTelegramChatIds = (env: Pick<Env, "TELEGRAM_CHAT_IDS">): string[] =>
  splitCsv(env.TELEGRAM_CHAT_IDS);

export const parseAdminTelegramChatIds = (env: Pick<Env, "ADMIN_TELEGRAM_CHAT_IDS">): string[] =>
  splitCsv(env.ADMIN_TELEGRAM_CHAT_IDS);

export const truncateForTelegram = (value: string, maxLength = SAFE_MESSAGE_LIMIT): string => {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 3).trimEnd()}...`;
};

const formatVerdict = (classification: Classification): string => {
  if (classification.verdict === "reset_confirmed") {
    return "RESET CONFIRMED";
  }

  if (classification.verdict === "uncertain") {
    return "UNCERTAIN";
  }

  return "NOT RESET";
};

export const formatAlertMessage = (tweet: Tweet, classification: Classification): string =>
  truncateForTelegram(
    [
      `@${tweet.authorUsername} posted`,
      "",
      `Verdict: ${formatVerdict(classification)}`,
      `Confidence: ${classification.confidence.toFixed(2)}`,
      `Reason: ${classification.rationale}`,
      "",
      `Post: ${tweet.url}`,
      "",
      "Text:",
      truncateForTelegram(tweet.fullText, 900),
    ].join("\n"),
  );

export const formatStatusMessage = (state: MonitorState): string => {
  const latest = state.recentDecisions[0];

  return truncateForTelegram(
    [
      "Codex limit monitor status",
      "",
      `Last check: ${state.lastCheckAt || "never"}`,
      `Last error: ${state.lastError ? "yes" : "no"}`,
      "",
      latest ? `Latest post: ${latest.tweetUrl}` : `Latest post: ${state.lastSeenTweetUrl || "none"}`,
      latest ? `Tweet posted: ${latest.tweetCreatedAt || "unknown"}` : null,
      latest ? `Verdict: ${latest.verdict} (${latest.confidence.toFixed(2)})` : "Verdict: none",
      latest ? `Reason: ${latest.rationale}` : null,
      latest?.tweetText ? "" : null,
      latest?.tweetText ? "Text:" : null,
      latest?.tweetText ? truncateForTelegram(latest.tweetText, 900) : null,
    ]
      .filter((line): line is string => line !== null)
      .join("\n"),
  );
};

export const getTelegramCommandReplyMarkup = (): unknown => ({
  keyboard: [["/status"], ["/subscribe", "/unsubscribe"], ["/help"]],
  resize_keyboard: true,
  one_time_keyboard: false,
  input_field_placeholder: "Choose a command",
});

const isPermanentTelegramError = (status: number, description: string): boolean => {
  const text = description.toLowerCase();

  return (
    status === 403 ||
    (status === 400 &&
      (text.includes("chat not found") ||
        text.includes("bot was blocked") ||
        text.includes("user is deactivated") ||
        text.includes("chat_id is empty")))
  );
};

export const sendTelegramMessage = async (
  env: Pick<Env, "TELEGRAM_BOT_TOKEN">,
  chatId: string,
  text: string,
  fetchFn: typeof fetch = fetch,
  options: TelegramMessageOptions = {},
): Promise<TelegramSendResult> => {
  const botToken = env.TELEGRAM_BOT_TOKEN?.trim();

  if (!botToken) {
    throw new Error("Missing TELEGRAM_BOT_TOKEN");
  }

  const payload: Record<string, unknown> = {
    chat_id: chatId,
    disable_web_page_preview: options.disableWebPagePreview ?? false,
    text: truncateForTelegram(text, TELEGRAM_MESSAGE_LIMIT),
  };

  if (options.replyMarkup) {
    payload.reply_markup = options.replyMarkup;
  }

  const response = await fetchFn(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const body = (await response.json().catch(() => null)) as { ok?: boolean; description?: string } | null;

  if (response.ok && body?.ok !== false) {
    return {
      messageId: typeof (body as any)?.result?.message_id === "number" ? (body as any).result.message_id : undefined,
      ok: true,
      status: response.status,
    };
  }

  const error = body?.description || `Telegram returned ${response.status}`;
  const permanent = isPermanentTelegramError(response.status, error);

  return {
    ok: false,
    status: response.status,
    error,
    permanent,
    retryable: !permanent,
  };
};

export const setTelegramCommands = async (
  env: Pick<Env, "TELEGRAM_BOT_TOKEN">,
  fetchFn: typeof fetch = fetch,
): Promise<TelegramSendResult> => {
  const botToken = env.TELEGRAM_BOT_TOKEN?.trim();

  if (!botToken) {
    throw new Error("Missing TELEGRAM_BOT_TOKEN");
  }

  const response = await fetchFn(`https://api.telegram.org/bot${botToken}/setMyCommands`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      commands: TELEGRAM_COMMANDS,
    }),
  });
  const body = (await response.json().catch(() => null)) as { ok?: boolean; description?: string } | null;

  if (response.ok && body?.ok !== false) {
    return {
      ok: true,
      status: response.status,
    };
  }

  const error = body?.description || `Telegram returned ${response.status}`;
  const permanent = isPermanentTelegramError(response.status, error);

  return {
    ok: false,
    status: response.status,
    error,
    permanent,
    retryable: !permanent,
  };
};

export const sendTelegramChatAction = async (
  env: Pick<Env, "TELEGRAM_BOT_TOKEN">,
  chatId: string,
  action = "typing",
  fetchFn: typeof fetch = fetch,
): Promise<void> => {
  const botToken = env.TELEGRAM_BOT_TOKEN?.trim();

  if (!botToken) {
    throw new Error("Missing TELEGRAM_BOT_TOKEN");
  }

  await fetchFn(`https://api.telegram.org/bot${botToken}/sendChatAction`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      action,
      chat_id: chatId,
    }),
  });
};

export const editTelegramMessage = async (
  env: Pick<Env, "TELEGRAM_BOT_TOKEN">,
  chatId: string,
  messageId: number,
  text: string,
  fetchFn: typeof fetch = fetch,
): Promise<TelegramSendResult> => {
  const botToken = env.TELEGRAM_BOT_TOKEN?.trim();

  if (!botToken) {
    throw new Error("Missing TELEGRAM_BOT_TOKEN");
  }

  const response = await fetchFn(`https://api.telegram.org/bot${botToken}/editMessageText`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      chat_id: chatId,
      disable_web_page_preview: false,
      message_id: messageId,
      text: truncateForTelegram(text, TELEGRAM_MESSAGE_LIMIT),
    }),
  });
  const body = (await response.json().catch(() => null)) as { ok?: boolean; description?: string; result?: { message_id?: number } } | null;

  if (response.ok && body?.ok !== false) {
    return {
      messageId: typeof body?.result?.message_id === "number" ? body.result.message_id : messageId,
      ok: true,
      status: response.status,
    };
  }

  const error = body?.description || `Telegram returned ${response.status}`;
  const permanent = isPermanentTelegramError(response.status, error);

  return {
    ok: false,
    status: response.status,
    error,
    permanent,
    retryable: !permanent,
  };
};
