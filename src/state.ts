import { getErrorMessage } from "./env";
import type { MonitorDecision, MonitorState } from "./types";

export const MONITOR_STATE_KEY = "monitor-state";
const MONITOR_LOCK_KEY = "monitor-lock";

export type MonitorLock = {
  acquired: boolean;
  token: string;
};

export const createInitialMonitorState = (): MonitorState => ({
  lastSeenTweetId: null,
  lastSeenTweetUrl: null,
  lastCheckAt: null,
  lastError: null,
  recentDecisions: [],
});

const normalizeDecision = (value: unknown): MonitorDecision | null => {
  const decision = value as Partial<MonitorDecision> | null;

  if (!decision || typeof decision.tweetId !== "string" || typeof decision.tweetUrl !== "string") {
    return null;
  }

  if (!["reset_confirmed", "not_reset", "uncertain"].includes(String(decision.verdict))) {
    return null;
  }

  return {
    tweetId: decision.tweetId,
    tweetUrl: decision.tweetUrl,
    tweetCreatedAt: typeof decision.tweetCreatedAt === "string" ? decision.tweetCreatedAt : "",
    tweetText: typeof decision.tweetText === "string" ? decision.tweetText : undefined,
    verdict: decision.verdict as MonitorDecision["verdict"],
    confidence: typeof decision.confidence === "number" ? decision.confidence : 0,
    rationale: typeof decision.rationale === "string" ? decision.rationale : "",
    alertedAt: typeof decision.alertedAt === "string" ? decision.alertedAt : "",
    deliveryMode: decision.deliveryMode === "cached" || decision.deliveryMode === "queued" ? decision.deliveryMode : "direct",
    deliveredCount: typeof decision.deliveredCount === "number" ? decision.deliveredCount : undefined,
    queuedCount: typeof decision.queuedCount === "number" ? decision.queuedCount : undefined,
  };
};

export const normalizeMonitorState = (value: unknown): MonitorState => {
  const state = value as Partial<MonitorState> | null;
  const decisions = Array.isArray(state?.recentDecisions)
    ? state.recentDecisions.map(normalizeDecision).filter((entry): entry is MonitorDecision => Boolean(entry))
    : [];

  return {
    lastSeenTweetId: typeof state?.lastSeenTweetId === "string" ? state.lastSeenTweetId : null,
    lastSeenTweetUrl: typeof state?.lastSeenTweetUrl === "string" ? state.lastSeenTweetUrl : null,
    lastCheckAt: typeof state?.lastCheckAt === "string" ? state.lastCheckAt : null,
    lastError: typeof state?.lastError === "string" ? state.lastError : null,
    recentDecisions: decisions,
  };
};

export const readMonitorState = async (kv: KVNamespace): Promise<MonitorState> => {
  const raw = await kv.get(MONITOR_STATE_KEY);

  if (!raw) {
    return createInitialMonitorState();
  }

  try {
    return normalizeMonitorState(JSON.parse(raw));
  } catch (_error) {
    return createInitialMonitorState();
  }
};

export const writeMonitorState = async (kv: KVNamespace, state: MonitorState): Promise<void> => {
  await kv.put(MONITOR_STATE_KEY, JSON.stringify(normalizeMonitorState(state)));
};

export const patchMonitorState = async (
  kv: KVNamespace,
  updater: (state: MonitorState) => MonitorState,
): Promise<MonitorState> => {
  const current = await readMonitorState(kv);
  const next = normalizeMonitorState(updater(current));
  await writeMonitorState(kv, next);
  return next;
};

export const appendRecentDecision = (
  state: MonitorState,
  decision: MonitorDecision,
  limit: number,
): MonitorState => {
  const boundedLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 50;
  const recentDecisions = [
    decision,
    ...state.recentDecisions.filter(
      (entry) => entry.tweetId !== decision.tweetId || entry.verdict !== decision.verdict,
    ),
  ].slice(0, boundedLimit);

  return {
    ...state,
    recentDecisions,
  };
};

export const recordMonitorError = async (kv: KVNamespace, error: unknown): Promise<void> => {
  const message = getErrorMessage(error, "Unknown monitor error");
  await patchMonitorState(kv, (state) => ({
    ...state,
    lastCheckAt: new Date().toISOString(),
    lastError: message,
  }));
};

export const clearMonitorErrorAndTouch = async (kv: KVNamespace): Promise<void> => {
  await patchMonitorState(kv, (state) => ({
    ...state,
    lastCheckAt: new Date().toISOString(),
    lastError: null,
  }));
};

export const acquireMonitorLock = async (kv: KVNamespace, ttlSeconds = 120): Promise<MonitorLock> => {
  const existing = await kv.get(MONITOR_LOCK_KEY);

  if (existing) {
    return {
      acquired: false,
      token: existing,
    };
  }

  const token = crypto.randomUUID();
  await kv.put(MONITOR_LOCK_KEY, token, { expirationTtl: ttlSeconds });

  return {
    acquired: true,
    token,
  };
};

export const releaseMonitorLock = async (kv: KVNamespace, lock: MonitorLock): Promise<void> => {
  if (!lock.acquired) {
    return;
  }

  const current = await kv.get(MONITOR_LOCK_KEY);

  if (current === lock.token) {
    await kv.delete(MONITOR_LOCK_KEY);
  }
};
