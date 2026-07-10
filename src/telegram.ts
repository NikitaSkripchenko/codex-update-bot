import { splitCsv } from "./env";
import type { Classification, Env, MonitorState, Tweet } from "./types";

const TELEGRAM_MESSAGE_LIMIT = 4096;
const SAFE_MESSAGE_LIMIT = 3900;
const STATUS_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_TODAY_STATUS_DECISIONS = 20;

export const TELEGRAM_COMMANDS = [
  { command: "status", description: "See today's results and the latest cached post" },
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
    return "Reset confirmed";
  }

  if (verdict === "uncertain") {
    return "Uncertain";
  }

  return "Not reset";
};

const formatVerdict = (classification: Classification): string => formatVerdictText(classification.verdict);

const formatConfidence = (confidence: number): string => `${Math.round(confidence * 100)}%`;

const formatDeliveryMode = (decision: MonitorState["recentDecisions"][number]): string => {
  if (decision.deliveryMode === "direct") {
    return `sent to ${decision.deliveredCount ?? 0} chat${decision.deliveredCount === 1 ? "" : "s"}`;
  }

  if (decision.deliveryMode === "queued") {
    return `queued for ${decision.queuedCount ?? 0} subscriber${decision.queuedCount === 1 ? "" : "s"}`;
  }

  return "cached only; no alert sent";
};

export const formatAlertMessage = (tweet: Tweet, classification: Classification): string =>
  truncateForTelegram(
    [
      "Codex reset alert",
      "",
      `Verdict: ${formatVerdict(classification)}`,
      `Confidence: ${formatConfidence(classification.confidence)}`,
      `Why: ${classification.rationale}`,
      "",
      "What to do: Open Codex or ChatGPT and try the blocked task again.",
      `Source: @${tweet.authorUsername}`,
      `Post: ${tweet.url}`,
      "",
      "Original post:",
      truncateForTelegram(tweet.fullText, 900),
    ].join("\n"),
  );

const getDecisionTimestamp = (decision: MonitorState["recentDecisions"][number]): number | null => {
  const timestamp = new Date(decision.tweetCreatedAt).valueOf();
  return Number.isFinite(timestamp) ? timestamp : null;
};

const getLatestDecision = (state: MonitorState): MonitorState["recentDecisions"][number] | undefined =>
  state.recentDecisions.find((decision) => decision.tweetId === state.lastSeenTweetId) ||
  [...state.recentDecisions].sort((left, right) => (getDecisionTimestamp(right) || 0) - (getDecisionTimestamp(left) || 0))[0];

const formatTodayDecision = (decision: MonitorState["recentDecisions"][number]): string =>
  `- ${formatVerdictText(decision.verdict)} (${formatConfidence(decision.confidence)}) | ${decision.tweetUrl}`;

export const formatStatusMessage = (state: MonitorState, now = new Date()): string => {
  const latest = getLatestDecision(state);
  const cutoff = now.valueOf() - STATUS_WINDOW_MS;
  const todayDecisions = state.recentDecisions
    .filter((decision) => {
      const timestamp = getDecisionTimestamp(decision);
      return timestamp !== null && timestamp >= cutoff && timestamp <= now.valueOf();
    })
    .sort((left, right) => (getDecisionTimestamp(right) || 0) - (getDecisionTimestamp(left) || 0));
  const visibleTodayDecisions = todayDecisions.slice(0, MAX_TODAY_STATUS_DECISIONS);
  const todaySummary = visibleTodayDecisions.length > 0
    ? visibleTodayDecisions.map(formatTodayDecision)
    : ["No cached posts in the last 24 hours."];

  return truncateForTelegram(
    [
      "Codex limit monitor",
      "",
      `Monitor: ${state.lastError ? "needs attention" : "healthy"}`,
      `Last checked: ${state.lastCheckAt || "never"}`,
      state.lastError ? `Last error: ${truncateForTelegram(state.lastError, 220)}` : null,
      "Alerts: confirmed resets only",
      "",
      "Today's results (last 24 hours):",
      ...todaySummary,
      todayDecisions.length > visibleTodayDecisions.length
        ? `Showing the newest ${MAX_TODAY_STATUS_DECISIONS} of ${todayDecisions.length} results.`
        : null,
      "",
      "Latest monitored post:",
      latest ? `Post: ${latest.tweetUrl}` : `Post: ${state.lastSeenTweetUrl || "none"}`,
      latest ? `Posted: ${latest.tweetCreatedAt || "unknown"}` : null,
      latest ? `Verdict: ${formatVerdictText(latest.verdict)} (${formatConfidence(latest.confidence)})` : "Verdict: none yet",
      latest ? `Delivery: ${formatDeliveryMode(latest)}` : null,
      latest ? `Why: ${latest.rationale}` : null,
      latest?.tweetText ? "" : null,
      latest?.tweetText ? "Original post:" : null,
      latest?.tweetText ? truncateForTelegram(latest.tweetText, 900) : null,
    ]
      .filter((line): line is string => line !== null)
      .join("\n"),
  );
};

export const formatHelpMessage = (publicSubscriptionsEnabled: boolean): string =>
  truncateForTelegram(
    [
      "Codex reset alert bot",
      "",
      "Use it when you want to know whether a monitored X post likely means Codex or ChatGPT limits reset.",
      "",
      "How it behaves:",
      "- I check configured X accounts on a schedule.",
      "- I only send alerts for confirmed resets.",
      "- /status shows cached results from the last 24 hours, then the latest monitored post. It never triggers a new monitor run.",
      "",
      "Commands:",
      "/status - show today's results and the latest cached post",
      publicSubscriptionsEnabled
        ? "/subscribe - get future confirmed reset alerts in this chat"
        : "/subscribe - unavailable until public subscriptions are enabled",
      "/unsubscribe - stop alerts in this chat",
      "/help - show this guide",
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
