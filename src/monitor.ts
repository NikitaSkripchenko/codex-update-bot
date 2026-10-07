import { isSuccessfulReset } from "./types";
import { isOpenRouterFallbackRationale } from "./classifier";
import { classifyConfiguredTweet, getConfiguredClassifierKeyName } from "./classification-provider";
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
import { compareTweetIds, fetchRecentTweets, getNewestTweet, isAuthoredByTargetUsername, sortTweetsAscending } from "./tweets";
import type { AlertEligibility, Classification, DispatchResult, Env, MonitorDecision, MonitorOutcome, MonitorState, Tweet } from "./types";

const ALERT_WINDOW_MS = 24 * 60 * 60 * 1000;

export type MonitorDeps = {
  classificationConcurrency?: number;
  fetchTweets?: (env: Env) => Promise<Tweet[]>;
  classify?: (env: Env, tweet: Tweet) => Promise<Classification>;
  dispatch?: (env: Env, tweet: Tweet, classification: Classification) => Promise<DispatchResult>;
};

// Classify concurrently; serialize state writes to avoid lost decisions.
const classifyBatch = async (
  tweets: Tweet[], env: Env, classify: (env: Env, tweet: Tweet) => Promise<Classification>,
  consume: (tweet: Tweet, result: Classification) => Promise<void>, concurrency = 1,
): Promise<void> => {
  let cursor = 0;
  let writes = Promise.resolve();
  const errors: string[] = [];
  const width = Number.isFinite(concurrency) ? Math.max(1, Math.min(5, Math.floor(concurrency))) : 1;
  await Promise.all(Array.from({ length: Math.min(width, tweets.length) }, async () => {
    while (cursor < tweets.length) {
      const tweet = tweets[cursor++];
      try {
        const result = await classify(env, tweet);
        const write = writes.then(() => consume(tweet, result));
        writes = write.catch(() => undefined);
        await write;
      } catch (error) {
        errors.push(`${tweet.id}: ${error instanceof Error ? error.message : String(error)}`);
        if (width === 1) break;
      }
    }
  }));
  if (errors.length) throw new Error(errors.join("\n"));
};

const validateMonitorConfig = (env: Env, deps: MonitorDeps): void => {
  const missing: string[] = [];

  if (!deps.classify) {
    const keyName = getConfiguredClassifierKeyName(env);
    if (!getEnvString(env[keyName])) {
      missing.push(keyName);
    }
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
  alertEligibility: AlertEligibility,
): MonitorState["recentDecisions"][number] => ({
  tweetId: tweet.id,
  tweetUrl: tweet.url,
  tweetCreatedAt: tweet.createdAt,
  tweetText: tweet.fullText,
  verdict: classification.verdict,
  confidence: classification.confidence,
  probabilities: classification.probabilities,
  rationale: classification.rationale,
  model: classification.model,
  usage: classification.usage,
  alertedAt: new Date().toISOString(),
  deliveryMode: dispatchResult.mode,
  alertEligibility,
  deliveredCount: dispatchResult.mode === "direct" ? dispatchResult.deliveredCount : undefined,
  queuedCount: dispatchResult.mode === "queued" ? dispatchResult.queuedCount : undefined,
});

const createCachedDecision = (
  tweet: Tweet,
  classification: Classification,
  alertEligibility: AlertEligibility,
): MonitorState["recentDecisions"][number] => ({
  tweetId: tweet.id,
  tweetUrl: tweet.url,
  tweetCreatedAt: tweet.createdAt,
  tweetText: tweet.fullText,
  verdict: classification.verdict,
  confidence: classification.confidence,
  probabilities: classification.probabilities,
  rationale: classification.rationale,
  model: classification.model,
  usage: classification.usage,
  alertedAt: new Date().toISOString(),
  deliveryMode: "cached",
  alertEligibility,
});

const shouldRefreshCachedDecision = (decision: MonitorState["recentDecisions"][number] | undefined): boolean => {
  if (!decision) {
    return true;
  }

  return isOpenRouterFallbackRationale(decision.rationale);
};

const shouldDispatchAlert = (classification: Classification): boolean => isSuccessfulReset(classification.verdict);

const appendSeedDecisions = async (
  env: Env,
  state: MonitorState,
  tweets: Tweet[],
  classify: (env: Env, tweet: Tweet) => Promise<Classification>,
  limit: number,
  concurrency = 1,
): Promise<MonitorState> => {
  let nextState = state;
  const cachedTweetIds = new Set(state.recentDecisions.map((decision) => decision.tweetId));

  await classifyBatch(tweets.slice(-limit).filter(tweet => !cachedTweetIds.has(tweet.id)), env, classify, async (tweet, classification) => {
    nextState = appendRecentDecision(nextState, createCachedDecision(tweet, classification, "initial_seed"), limit);
    await writeMonitorState(env.MONITOR_STATE, { ...nextState, lastSeenTweetId: null, lastSeenTweetUrl: null });
  }, concurrency);

  return nextState;
};

const isValidTweetId = (value: string | null): boolean => typeof value === "string" && /^\d+$/.test(value);

const getAlertEligibility = (tweet: Tweet, existing?: MonitorDecision): AlertEligibility => {
  if (existing?.alertEligibility === "initial_seed" || existing?.alertEligibility === "historical") {
    return existing.alertEligibility;
  }

  const publishedAt = new Date(tweet.createdAt).valueOf();
  const ageMs = Date.now() - publishedAt;
  return Number.isFinite(publishedAt) && ageMs >= 0 && ageMs < ALERT_WINDOW_MS ? "eligible" : "historical";
};

const decisionToTweet = (decision: MonitorDecision): Tweet => {
  let authorUsername = "unknown";

  try {
    authorUsername = new URL(decision.tweetUrl).pathname.split("/").filter(Boolean)[0] || "unknown";
  } catch (_error) {
    // Keep the fallback username; the alert still links to the saved URL.
  }

  return {
    id: decision.tweetId,
    url: decision.tweetUrl,
    createdAt: decision.tweetCreatedAt,
    fullText: decision.tweetText || "",
    authorUsername,
    isReply: false,
    isRetweet: false,
  };
};

const withMonotonicWatermark = (state: MonitorState, tweet: Tweet): MonitorState => {
  if (state.lastSeenTweetId && compareTweetIds(tweet.id, state.lastSeenTweetId) <= 0) {
    return state;
  }

  return {
    ...state,
    lastSeenTweetId: tweet.id,
    lastSeenTweetUrl: tweet.url,
  };
};

const persistDecision = async (
  env: Env,
  state: MonitorState,
  decision: MonitorDecision,
  limit: number,
): Promise<MonitorState> => {
  const nextState = appendRecentDecision(
    {
      ...state,
      lastCheckAt: new Date().toISOString(),
      lastError: null,
    },
    decision,
    limit,
  );
  await writeMonitorState(env.MONITOR_STATE, nextState);
  return nextState;
};

const reconcilePendingAlerts = async (
  env: Env,
  state: MonitorState,
  dispatch: (env: Env, tweet: Tweet, classification: Classification) => Promise<DispatchResult>,
  limit: number,
): Promise<MonitorState> => {
  let nextState = state;
  const pending = state.recentDecisions.filter(
    (decision) =>
      isSuccessfulReset(decision.verdict) &&
      decision.deliveryMode === "cached" &&
      decision.alertEligibility === "eligible",
  );

  for (const decision of pending) {
    const tweet = decisionToTweet(decision);
    const eligibility = getAlertEligibility(tweet, decision);

    if (eligibility !== "eligible") {
      nextState = await persistDecision(env, nextState, { ...decision, alertEligibility: eligibility }, limit);
      continue;
    }

    const classification: Classification = {
      verdict: decision.verdict,
      confidence: decision.confidence,
      probabilities: decision.probabilities,
      rationale: decision.rationale,
      model: decision.model,
      usage: decision.usage,
    };
    const dispatchResult = await dispatch(env, tweet, classification);
    console.log(JSON.stringify({
      event: "monitor_pending_alert_dispatched",
      tweetId: tweet.id,
      mode: dispatchResult.mode,
      recipientCount: dispatchResult.mode === "queued" ? dispatchResult.queuedCount : dispatchResult.deliveredCount,
    }));
    nextState = await persistDecision(
      env,
      nextState,
      createDecision(tweet, classification, dispatchResult, eligibility),
      limit,
    );
  }

  return nextState;
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
    const classify = deps.classify || classifyConfiguredTweet;
    const dispatch = deps.dispatch || dispatchAlert;
    const recentDecisionLimit = getNumberEnv(env.RECENT_DECISION_LIMIT, 50);
    state = await reconcilePendingAlerts(env, state, dispatch, recentDecisionLimit);
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
      state = {
        ...state,
        lastSeenTweetId: newestTweet.id,
        lastSeenTweetUrl: newestTweet.url,
        lastCheckAt: new Date().toISOString(),
        lastError: null,
      };

      state = await appendSeedDecisions(env, state, authoredTweets, classify, recentDecisionLimit, deps.classificationConcurrency);

      await writeMonitorState(env.MONITOR_STATE, state);

      return {
        outcome: "seeded",
        processedCount: 0,
        lastSeenTweetId: newestTweet.id,
      };
    }

    let processedCount = 0;
    const startingWatermark = state.lastSeenTweetId;
    const tweetsToProcess = authoredTweets.filter((tweet) => {
      const existing = state.recentDecisions.find((decision) => decision.tweetId === tweet.id);
      return !existing || shouldRefreshCachedDecision(existing);
    }).slice(-recentDecisionLimit);

    await classifyBatch(tweetsToProcess, env, classify, async (tweet, classification) => {
      const existing = state.recentDecisions.find((decision) => decision.tweetId === tweet.id);
      const alertEligibility = getAlertEligibility(tweet, existing);
      state = withMonotonicWatermark(state, tweet);
      state = await persistDecision(
        env,
        state,
        createCachedDecision(tweet, classification, alertEligibility),
        recentDecisionLimit,
      );

      const shouldDispatch = shouldDispatchAlert(classification) && alertEligibility === "eligible";

      if (shouldDispatch) {
        const dispatchResult = await dispatch(env, tweet, classification);
        console.log(JSON.stringify({
          event: "monitor_alert_dispatched",
          tweetId: tweet.id,
          mode: dispatchResult.mode,
          recipientCount: dispatchResult.mode === "queued" ? dispatchResult.queuedCount : dispatchResult.deliveredCount,
        }));
        state = await persistDecision(
          env,
          state,
          createDecision(tweet, classification, dispatchResult, alertEligibility),
          recentDecisionLimit,
        );
      }

      if (isSuccessfulReset(classification.verdict) && alertEligibility !== "eligible") {
        console.log(JSON.stringify({
          event: "monitor_alert_suppressed",
          tweetId: tweet.id,
          reason: alertEligibility,
        }));
      }

      const advancedFromStartingWatermark =
        !startingWatermark || compareTweetIds(tweet.id, startingWatermark) > 0;

      if (alertEligibility === "eligible" && (advancedFromStartingWatermark || shouldDispatch)) {
        processedCount += 1;
      }
    }, deps.classificationConcurrency);

    if (processedCount === 0) {
      await markChecked(env);
    }

    return {
      outcome: processedCount > 0 ? "processed" : "no_new_tweets",
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
