import { jsonResponse } from "./env";
import type { Env } from "./types";

export type FixedWindowRecord = {
  count: number;
  resetAt: number;
};

export type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  resetAt: number;
  retryAfterSeconds: number;
};

type RateLimitCheckBody = {
  key?: string;
  limit?: number;
  windowSeconds?: number;
  cost?: number;
};

const RATE_LIMIT_KEY_PREFIX = "rate-limit:";

const sanitizeRateLimitKey = (key: string): string => key.replace(/[^a-zA-Z0-9:._-]/g, "_").slice(0, 180);

export const consumeFixedWindow = (
  record: FixedWindowRecord | null,
  nowMs: number,
  limit: number,
  windowSeconds: number,
  cost = 1,
): { result: RateLimitResult; record: FixedWindowRecord } => {
  const boundedLimit = Math.max(1, Math.floor(limit));
  const boundedCost = Math.max(1, Math.floor(cost));
  const boundedWindowMs = Math.max(1, Math.floor(windowSeconds)) * 1000;
  const activeRecord = record && record.resetAt > nowMs ? record : { count: 0, resetAt: nowMs + boundedWindowMs };
  const nextCount = activeRecord.count + boundedCost;
  const allowed = nextCount <= boundedLimit;
  const nextRecord = allowed ? { ...activeRecord, count: nextCount } : activeRecord;

  return {
    record: nextRecord,
    result: {
      allowed,
      remaining: Math.max(0, boundedLimit - nextRecord.count),
      resetAt: nextRecord.resetAt,
      retryAfterSeconds: allowed ? 0 : Math.max(1, Math.ceil((nextRecord.resetAt - nowMs) / 1000)),
    },
  };
};

const readJsonRecord = async (kv: KVNamespace, key: string): Promise<FixedWindowRecord | null> => {
  const raw = await kv.get(key);

  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<FixedWindowRecord>;

    if (typeof parsed.count === "number" && typeof parsed.resetAt === "number") {
      return {
        count: parsed.count,
        resetAt: parsed.resetAt,
      };
    }
  } catch (_error) {
    return null;
  }

  return null;
};

const checkRateLimitWithKv = async (
  env: Env,
  key: string,
  limit: number,
  windowSeconds: number,
  cost: number,
): Promise<RateLimitResult> => {
  const storageKey = `${RATE_LIMIT_KEY_PREFIX}${sanitizeRateLimitKey(key)}`;
  const nowMs = Date.now();
  const current = await readJsonRecord(env.MONITOR_STATE, storageKey);
  const { result, record } = consumeFixedWindow(current, nowMs, limit, windowSeconds, cost);
  const expirationTtl = Math.max(1, Math.ceil((record.resetAt - nowMs) / 1000));
  await env.MONITOR_STATE.put(storageKey, JSON.stringify(record), { expirationTtl });

  return result;
};

export const checkRateLimit = async (
  env: Env,
  key: string,
  limit: number,
  windowSeconds: number,
  cost = 1,
): Promise<RateLimitResult> => {
  if (!env.RATE_LIMITER) {
    return checkRateLimitWithKv(env, key, limit, windowSeconds, cost);
  }

  const id = env.RATE_LIMITER.idFromName("telegram-command-rate-limiter");
  const response = await env.RATE_LIMITER.get(id).fetch("https://rate-limit.local/check", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      cost,
      key,
      limit,
      windowSeconds,
    }),
  });

  if (!response.ok) {
    throw new Error(`Rate limiter failed with ${response.status}`);
  }

  return response.json<RateLimitResult>();
};

export class RateLimiter {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method !== "POST" || url.pathname !== "/check") {
      return new Response("Not found", { status: 404 });
    }

    const body = (await request.json().catch(() => ({}))) as RateLimitCheckBody;
    const key = sanitizeRateLimitKey(typeof body.key === "string" ? body.key : "unknown");
    const limit = typeof body.limit === "number" ? body.limit : 1;
    const windowSeconds = typeof body.windowSeconds === "number" ? body.windowSeconds : 60;
    const cost = typeof body.cost === "number" ? body.cost : 1;
    const storageKey = `${RATE_LIMIT_KEY_PREFIX}${key}`;
    const nowMs = Date.now();
    const current = (await this.state.storage.get<FixedWindowRecord>(storageKey)) || null;
    const { result, record } = consumeFixedWindow(current, nowMs, limit, windowSeconds, cost);
    await this.state.storage.put(storageKey, record);

    return jsonResponse(result);
  }
}
