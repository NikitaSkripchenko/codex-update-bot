import { classifyTweet } from "./classifier";
import { getEnvString, getNumberEnv, getTargetUsernames, isPublicSubscriptionsEnabled } from "./env";
import { dispatchAlert } from "./delivery-queue";
import {
  acquireMonitorLock,
  appendRecentDecision,
  clearMonitorErrorAndTouch,
  readMonitorState,
  recordMonitorError,
  releaseMonitorLock,
  writeMonitorState,
} from "./state";
import { fetchRecentTweets, getNewestTweet, getUnseenTweets, isAuthoredByTargetUsername, sortTweetsAscending } from "./tweets";
import type { Classification, DispatchResult, Env, MonitorOutcome, MonitorState, Tweet } from "./types";

const TWITTER_SNOWFLAKE_EPOCH_MS = 1_288_834_974_657;
const DEFAULT_HISTORICAL_BACKFILL_MIN_HOURS = 24;

export type MonitorDeps = {
  fetchTweets?: (env: Env) => Promise<Tweet[]>;
  classify?: (env: Env, tweet: Tweet) => Promise<Classification>;
  dispatch?: (env: Env, tweet: Tweet, classification: Classification) => Promise<DispatchResult>;
};

const validateMonitorConfig = (env: Env, deps: MonitorDeps): void => {
  const missing: string[] = [];

  if (!deps.classify && !getEnvString(env.OPENROUTER_API_KEY)) {
    missing.push("OPENROUTER_API_KEY");
  }

  if (!deps.dispatch && !getEnvString(env.TELEGRAM_BOT_TOKEN)) {
    missing.push("TELEGRAM_BOT_TOKEN");
  }

  if (!deps.dispatch && isPublicSubscriptionsEnabled(env)) {
    if (!env.SUBSCRIPTIONS_DB) {
      missing.push("SUBSCRIPTIONS_DB");
    }

    if (!env.TELEGRAM_DELIVERY_QUEUE) {
      missing.push("TELEGRAM_DELIVERY_QUEUE");
    }
  }

  if (!deps.dispatch && !isPublicSubscriptionsEnabled(env) && !getEnvString(env.TELEGRAM_CHAT_IDS)) {
    missing.push("TELEGRAM_CHAT_IDS");
  }

  if (missing.length > 0) {
    throw new Error(`Missing monitor configuration: ${missing.join(", ")}`);
  }
};

const createDecision = (
  tweet: Tweet,
  classification: Classification,
  dispatchResult: DispatchResult,
): MonitorState["recentDecisions"][number] => ({
  tweetId: tweet.id,
  tweetUrl: tweet.url,
  tweetCreatedAt: tweet.createdAt,
  tweetText: tweet.fullText,
  verdict: classification.verdict,
  confidence: classification.confidence,
  rationale: classification.rationale,
  alertedAt: new Date().toISOString(),
  deliveryMode: dispatchResult.mode,
  deliveredCount: dispatchResult.mode === "direct" ? dispatchResult.deliveredCount : undefined,
  queuedCount: dispatchResult.mode === "queued" ? dispatchResult.queuedCount : undefined,
});

const createCachedDecision = (
  tweet: Tweet,
  classification: Classification,
): MonitorState["recentDecisions"][number] => ({
  tweetId: tweet.id,
  tweetUrl: tweet.url,
  tweetCreatedAt: tweet.createdAt,
  tweetText: tweet.fullText,
  verdict: classification.verdict,
  confidence: classification.confidence,
  rationale: classification.rationale,
  alertedAt: new Date().toISOString(),
  deliveryMode: "cached",
});

const shouldRefreshCachedDecision = (decision: MonitorState["recentDecisions"][number] | undefined): boolean => {
  if (!decision) {
    return true;
  }

  return decision.rationale.startsWith("OpenRouter returned") || decision.rationale.startsWith("OpenRouter unavailable");
};

const shouldDispatchAlert = (classification: Classification): boolean => classification.verdict === "reset_confirmed";

const isValidTweetId = (value: string | null): boolean => typeof value === "string" && /^\d+$/.test(value);

const isAfterLastCheck = (tweet: Tweet, lastCheckAt: string | null): boolean => {
  if (!lastCheckAt) {
    return true;
  }

  const tweetTimestamp = new Date(tweet.createdAt).valueOf();
  const lastCheckTimestamp = new Date(lastCheckAt).valueOf();

  return Number.isFinite(tweetTimestamp) && Number.isFinite(lastCheckTimestamp) && tweetTimestamp > lastCheckTimestamp;
};

const parseTimestamp = (value: string | null | undefined): number | null => {
  if (!value) {
    return null;
  }

  const timestamp = new Date(value).valueOf();
  return Number.isFinite(timestamp) ? timestamp : null;
};

const parseTweetIdTimestamp = (id: string | null | undefined): number | null => {
  if (!id || !/^\d+$/.test(id)) {
    return null;
  }

  try {
    return Number((BigInt(id) >> 22n) + BigInt(TWITTER_SNOWFLAKE_EPOCH_MS));
  } catch {
    return null;
  }
};

const getTweetTimestamp = (tweet: Tweet): number | null =>
  parseTimestamp(tweet.createdAt) ?? parseTweetIdTimestamp(tweet.id);

const getLastSeenTimestamp = (state: MonitorState): number | null => {
  const decision = state.recentDecisions.find((entry) => entry.tweetId === state.lastSeenTweetId);
  return parseTimestamp(decision?.tweetCreatedAt) ?? parseTweetIdTimestamp(state.lastSeenTweetId);
};

const isHistoricalSourceJump = (env: Env, state: MonitorState, unseenTweets: Tweet[]): boolean => {
  const latestUnseenTweet = unseenTweets[unseenTweets.length - 1];

  if (!latestUnseenTweet) {
    return false;
  }

  const latestUnseenTimestamp = getTweetTimestamp(latestUnseenTweet);
  const lastCheckTimestamp = parseTimestamp(state.lastCheckAt);
  const lastSeenTimestamp = getLastSeenTimestamp(state);

  if (!latestUnseenTimestamp || !lastCheckTimestamp || !lastSeenTimestamp || latestUnseenTimestamp > lastCheckTimestamp) {
    return false;
  }

  const minimumGapMs = getNumberEnv(env.POLL_LOOKBACK_HOURS, DEFAULT_HISTORICAL_BACKFILL_MIN_HOURS) * 60 * 60 * 1000;
  return latestUnseenTimestamp - lastSeenTimestamp > minimumGapMs;
};

const markChecked = async (env: Env): Promise<void> => {
  await clearMonitorErrorAndTouch(env.MONITOR_STATE);
};

export const runMonitor = async (env: Env, deps: MonitorDeps = {}): Promise<MonitorOutcome> => {
  validateMonitorConfig(env, deps);

  const lock = await acquireMonitorLock(env.MONITOR_STATE);

  if (!lock.acquired) {
    return {
      outcome: "locked",
      processedCount: 0,
    };
  }

  try {
    let state = await readMonitorState(env.MONITOR_STATE);
    const targetUsernames = getTargetUsernames(env);
    const fetchTweets = deps.fetchTweets || fetchRecentTweets;
    const classify = deps.classify || classifyTweet;
    const dispatch = deps.dispatch || dispatchAlert;
    const timelineTweets = await fetchTweets(env);
    const authoredTweets = sortTweetsAscending(
      timelineTweets.filter((tweet) => isAuthoredByTargetUsername(tweet, targetUsernames)),
    );
    const newestTweet = getNewestTweet(authoredTweets);

    if (!newestTweet) {
      await markChecked(env);
      return {
        outcome: "no_tweets",
        processedCount: 0,
      };
    }

    if (state.lastSeenTweetId && !isValidTweetId(state.lastSeenTweetId)) {
      state = {
        ...state,
        lastSeenTweetId: null,
        lastSeenTweetUrl: null,
      };
    }

    if (!state.lastSeenTweetId) {
      const classification = await classify(env, newestTweet);
      state = appendRecentDecision(
        {
          ...state,
          lastSeenTweetId: newestTweet.id,
          lastSeenTweetUrl: newestTweet.url,
          lastCheckAt: new Date().toISOString(),
          lastError: null,
        },
        createCachedDecision(newestTweet, classification),
        getNumberEnv(env.RECENT_DECISION_LIMIT, 50),
      );
      await writeMonitorState(env.MONITOR_STATE, state);

      return {
        outcome: "seeded",
        processedCount: 0,
        lastSeenTweetId: newestTweet.id,
      };
    }

    const unseenTweets = getUnseenTweets(authoredTweets, state.lastSeenTweetId);

    if (unseenTweets.length === 0) {
      const latestDecision = state.recentDecisions.find((decision) => decision.tweetId === newestTweet.id);

      if (shouldRefreshCachedDecision(latestDecision)) {
        const classification = await classify(env, newestTweet);
        state = appendRecentDecision(
          {
            ...state,
            lastSeenTweetId: newestTweet.id,
            lastSeenTweetUrl: newestTweet.url,
            lastCheckAt: new Date().toISOString(),
            lastError: null,
          },
          createCachedDecision(newestTweet, classification),
          getNumberEnv(env.RECENT_DECISION_LIMIT, 50),
        );
        await writeMonitorState(env.MONITOR_STATE, state);
      } else {
        await markChecked(env);
      }

      return {
        outcome: "no_new_tweets",
        processedCount: 0,
        lastSeenTweetId: state.lastSeenTweetId || undefined,
      };
    }

    const alertableTweets = unseenTweets.filter((tweet) => isAfterLastCheck(tweet, state.lastCheckAt));

    if (alertableTweets.length === 0 && isHistoricalSourceJump(env, state, unseenTweets)) {
      const latestBackfilledTweet = unseenTweets[unseenTweets.length - 1];
      const classification = await classify(env, latestBackfilledTweet);
      state = appendRecentDecision(
        {
          ...state,
          lastSeenTweetId: latestBackfilledTweet.id,
          lastSeenTweetUrl: latestBackfilledTweet.url,
          lastCheckAt: new Date().toISOString(),
          lastError: null,
        },
        createCachedDecision(latestBackfilledTweet, classification),
        getNumberEnv(env.RECENT_DECISION_LIMIT, 50),
      );
      await writeMonitorState(env.MONITOR_STATE, state);

      return {
        outcome: "no_new_tweets",
        processedCount: 0,
        lastSeenTweetId: state.lastSeenTweetId || undefined,
      };
    }

    let processedCount = 0;
    const recentDecisionLimit = getNumberEnv(env.RECENT_DECISION_LIMIT, 50);
    const tweetsToProcess = alertableTweets.length > 0 ? alertableTweets : unseenTweets;

    for (const tweet of tweetsToProcess) {
      const classification = await classify(env, tweet);
      const dispatchResult = shouldDispatchAlert(classification) ? await dispatch(env, tweet, classification) : null;
      const decision = dispatchResult
        ? createDecision(tweet, classification, dispatchResult)
        : createCachedDecision(tweet, classification);

      state = appendRecentDecision(
        {
          ...state,
          lastSeenTweetId: tweet.id,
          lastSeenTweetUrl: tweet.url,
          lastCheckAt: new Date().toISOString(),
          lastError: null,
        },
        decision,
        recentDecisionLimit,
      );
      await writeMonitorState(env.MONITOR_STATE, state);
      processedCount += 1;
    }

    return {
      outcome: "processed",
      processedCount,
      lastSeenTweetId: state.lastSeenTweetId || undefined,
    };
  } catch (error) {
    await recordMonitorError(env.MONITOR_STATE, error);
    throw error;
  } finally {
    await releaseMonitorLock(env.MONITOR_STATE, lock);
  }
};
