import { splitCsv } from "./env";
import { isOpenRouterFallbackRationale } from "./classifier";
import { getLatestActiveReset } from "./state";
import type { Classification, Env, MonitorState, Tweet } from "./types";

const TELEGRAM_MESSAGE_LIMIT = 4096;
const SAFE_MESSAGE_LIMIT = 3900;

const escapeTelegramHtml = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const telegramLink = (url: string, label: string): string =>
  `<a href="${escapeTelegramHtml(url)}">${escapeTelegramHtml(label)}</a>`;

const telegramQuote = (value: string, expandable = false): string =>
  `<blockquote${expandable ? " expandable" : ""}>${escapeTelegramHtml(value)}</blockquote>`;

export const TELEGRAM_COMMANDS = [
  { command: "status", description: "See the latest cached post" },
  { command: "subscribe", description: "Get confirmed reset alerts in this chat" },
  { command: "unsubscribe", description: "Stop reset alerts in this chat" },
  { command: "help", description: "See how the bot works" },
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

const formatVerdictText = (verdict: Classification["verdict"]): string => {
  if (verdict === "reset_confirmed") {
    return "✅ Reset confirmed";
  }

  if (verdict === "uncertain") {
    return "⚠️ Uncertain";
  }

  return "❌ Not reset";
};

const formatVerdict = (classification: Classification): string => formatVerdictText(classification.verdict);

const formatConfidence = (confidence: number): string => `${Math.round(confidence * 100)}%`;

const formatPublicRationale = (rationale: string): string => {
  if (!isOpenRouterFallbackRationale(rationale)) {
    return rationale;
  }

  const separatorIndex = rationale.indexOf("; ");
  return separatorIndex >= 0 ? rationale.slice(separatorIndex + 2) : rationale;
};

const formatResetStatus = (isActive: boolean): string =>
  isActive
    ? "✅ Active (a reset was confirmed within the last 24 hours)"
    : "❌ Inactive (no reset was confirmed within the last 24 hours)";

export const formatAlertMessage = (tweet: Tweet, classification: Classification): string =>
  truncateForTelegram(
    [
      "<b>Codex limit reset</b>",
      "",
      telegramQuote(`${formatVerdict(classification)}\n${formatConfidence(classification.confidence)} confidence`),
      `<b>Why it matters</b>\n${escapeTelegramHtml(formatPublicRationale(classification.rationale))}`,
      "",
      "<b>Next step</b>\nOpen Codex or ChatGPT and retry the blocked task.",
      telegramLink(tweet.url, `View post from @${tweet.authorUsername}`),
      "",
      "<b>Original post</b>",
      telegramQuote(truncateForTelegram(tweet.fullText, 900), true),
    ].join("\n"),
  );

const getLatestDecision = (state: MonitorState): MonitorState["recentDecisions"][number] | undefined =>
  state.recentDecisions.find((decision) => decision.tweetId === state.lastSeenTweetId) ||
  state.recentDecisions[0];

export const formatStatusMessage = (state: MonitorState): string => {
  const latest = getLatestDecision(state);
  const latestReset = getLatestActiveReset(state);

  return truncateForTelegram(
    [
      "<b>Codex limit monitor</b>",
      "",
      `<b>Reset status</b>: ${formatResetStatus(Boolean(latestReset))}${
        latestReset ? ` ${telegramLink(latestReset.tweetUrl, "View confirming post")}` : ""
      }`,
      "",
      "______________________________",
      "",
      "<b>Latest monitored post</b>",
      latest ? telegramLink(latest.tweetUrl, "View post") : state.lastSeenTweetUrl ? telegramLink(state.lastSeenTweetUrl, "View post") : "No post yet.",
      latest ? `<b>Posted</b>: ${escapeTelegramHtml(latest.tweetCreatedAt || "unknown")}` : null,
      latest ? `<b>Latest post verdict</b>: ${escapeTelegramHtml(formatVerdictText(latest.verdict))}` : null,
      latest ? `<b>Why</b>: ${escapeTelegramHtml(formatPublicRationale(latest.rationale))}` : null,
    ]
      .filter((line): line is string => line !== null)
      .join("\n"),
  );
};

export const formatHelpMessage = (publicSubscriptionsEnabled: boolean): string =>
  truncateForTelegram(
    [
      "<b>Codex limit reset alerts</b>",
      "",
      "Get a notification when a monitored X post confirms that Codex or ChatGPT limits have reset.",
      "",
      "<b>How it works</b>",
      "- I check configured X accounts on a schedule.",
      "- I only alert on confirmed resets.",
      "- <code>/status</code> shows cached results and never runs a new check.",
      "",
      "<b>Commands</b>",
      "<code>/status</code> - the latest monitored post",
      publicSubscriptionsEnabled
        ? "<code>/subscribe</code> - receive future confirmed alerts here"
        : "<code>/subscribe</code> - currently unavailable",
      "<code>/unsubscribe</code> - stop alerts in this chat",
      "<code>/help</code> - show this guide",
    ].join("\n"),
  );

export const getTelegramCommandReplyMarkup = (): unknown => ({
  keyboard: [["/status"], ["/subscribe", "/unsubscribe"], ["/help"]],
  resize_keyboard: true,
  one_time_keyboard: false,
  input_field_placeholder: "Tap a command or type /status",
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
    parse_mode: "HTML",
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
      parse_mode: "HTML",
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
