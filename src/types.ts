export type ClassificationVerdict = "reset_confirmed" | "not_reset" | "uncertain";
export type AlertEligibility = "eligible" | "initial_seed" | "historical";

export type Tweet = {
  id: string;
  url: string;
  createdAt: string;
  fullText: string;
  authorUsername: string;
  isRetweet: boolean;
  isReply: boolean;
  quotedText?: string | null;
  quotedUrl?: string | null;
  quotedCreatedAt?: string | null;
};

export type Classification = {
  verdict: ClassificationVerdict;
  confidence: number;
  rationale: string;
  model?: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    totalTokens: number;
  };
};

export type MonitorDecision = {
  tweetId: string;
  tweetUrl: string;
  tweetCreatedAt: string;
  tweetText?: string;
  verdict: ClassificationVerdict;
  confidence: number;
  rationale: string;
  model?: string;
  usage?: Classification["usage"];
  alertedAt: string;
  deliveryMode: "cached" | "direct" | "queued";
  alertEligibility?: AlertEligibility;
  deliveredCount?: number;
  queuedCount?: number;
};

export type MonitorState = {
  lastSeenTweetId: string | null;
  lastSeenTweetUrl: string | null;
  lastCheckAt: string | null;
  lastError: string | null;
  recentDecisions: MonitorDecision[];
};

export type DeliveryQueueMessage = {
  alertId: string;
  tweet: Tweet;
  classification: Classification;
  chatIds: string[];
};

export type Env = {
  MONITOR_STATE: KVNamespace;
  SUBSCRIPTIONS_DB?: D1Database;
  TELEGRAM_DELIVERY_QUEUE?: Queue<DeliveryQueueMessage>;
  RATE_LIMITER?: DurableObjectNamespace;
  OPENROUTER_API_KEY?: string;
  OPENROUTER_MODEL?: string;
  OPENROUTER_SITE_URL?: string;
  OPENROUTER_APP_NAME?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_IDS?: string;
  ADMIN_TELEGRAM_CHAT_IDS?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  RETTIWT_API_KEY?: string;
  CRON_SECRET?: string;
  TARGET_USERNAME?: string;
  TARGET_USERNAMES?: string;
  POLL_LOOKBACK_HOURS?: string;
  RECENT_DECISION_LIMIT?: string;
  PUBLIC_SUBSCRIPTIONS_ENABLED?: string;
  TELEGRAM_SEND_DELAY_MS?: string;
};

export type MonitorOutcome = {
  outcome: "locked" | "seeded" | "no_tweets" | "no_new_tweets" | "processed";
  processedCount: number;
  lastSeenTweetId?: string;
};

export type DispatchResult =
  | {
      mode: "direct";
      deliveredCount: number;
      permanentFailureCount: number;
    }
  | {
      mode: "queued";
      queuedCount: number;
    };
