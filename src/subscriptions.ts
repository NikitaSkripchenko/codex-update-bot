import type { Env } from "./types";

const DELIVERY_CLAIM_SECONDS = 120;

type D1RunResult = {
  meta?: Record<string, unknown>;
};

type DeliveryRecord = {
  status: string;
  delivered_at: string | null;
  claimed_until: string | null;
};

type SubscriptionRecord = {
  status: string;
};

export type SubscribeResult = "already_active" | "created" | "reactivated";
export type UnsubscribeResult = "already_inactive" | "unsubscribed";

const requireDb = (env: Env): D1Database => {
  if (!env.SUBSCRIPTIONS_DB) {
    throw new Error("SUBSCRIPTIONS_DB binding is required when public subscriptions are enabled");
  }

  return env.SUBSCRIPTIONS_DB;
};

const getRowsWritten = (result: D1RunResult): number => {
  const meta = result.meta || {};
  const value = meta.rows_written ?? meta.changes ?? meta.changed_rows;
  return typeof value === "number" ? value : 0;
};

const nowIso = (): string => new Date().toISOString();

export const upsertSubscription = async (env: Env, chatId: string, chatType: string): Promise<SubscribeResult> => {
  const db = requireDb(env);
  const existing = await db
    .prepare(
      `select status
       from telegram_subscriptions
       where chat_id = ?`,
    )
    .bind(chatId)
    .first<SubscriptionRecord>();

  if (existing?.status === "active") {
    return "already_active";
  }

  const now = nowIso();

  await db
    .prepare(
      `insert into telegram_subscriptions (chat_id, chat_type, status, subscribed_at, unsubscribed_at, failure_count, last_delivery_error, last_delivery_error_at)
       values (?, ?, 'active', ?, null, 0, null, null)
       on conflict(chat_id) do update set
         chat_type = excluded.chat_type,
         status = 'active',
         subscribed_at = excluded.subscribed_at,
         unsubscribed_at = null,
         failure_count = 0,
         last_delivery_error = null,
         last_delivery_error_at = null`,
    )
    .bind(chatId, chatType, now)
    .run();

  return existing ? "reactivated" : "created";
};

export const unsubscribeChat = async (env: Env, chatId: string): Promise<UnsubscribeResult> => {
  const db = requireDb(env);
  const existing = await db
    .prepare(
      `select status
       from telegram_subscriptions
       where chat_id = ?`,
    )
    .bind(chatId)
    .first<SubscriptionRecord>();

  if (!existing || existing.status === "unsubscribed") {
    return "already_inactive";
  }

  await db
    .prepare(
      `update telegram_subscriptions
       set status = 'unsubscribed', unsubscribed_at = ?
       where chat_id = ?`,
    )
    .bind(nowIso(), chatId)
    .run();

  return "unsubscribed";
};

export const listActiveChatIds = async (env: Env, limit = 500, offset = 0): Promise<string[]> => {
  const result = await requireDb(env)
    .prepare(
      `select chat_id
       from telegram_subscriptions
       where status = 'active'
       order by subscribed_at asc
       limit ? offset ?`,
    )
    .bind(limit, offset)
    .all<{ chat_id: string }>();

  return (result.results || []).map((entry) => entry.chat_id).filter(Boolean);
};

export const getSubscriptionStats = async (env: Env): Promise<{ active: number; disabled: number }> => {
  if (!env.SUBSCRIPTIONS_DB) {
    return {
      active: 0,
      disabled: 0,
    };
  }

  const result = await env.SUBSCRIPTIONS_DB
    .prepare(
      `select
        sum(case when status = 'active' then 1 else 0 end) as active,
        sum(case when status = 'disabled' then 1 else 0 end) as disabled
       from telegram_subscriptions`,
    )
    .first<{ active: number | null; disabled: number | null }>();

  return {
    active: Number(result?.active || 0),
    disabled: Number(result?.disabled || 0),
  };
};

export const claimDelivery = async (env: Env, alertId: string, chatId: string): Promise<boolean> => {
  const db = requireDb(env);
  const now = nowIso();
  const claimedUntil = new Date(Date.now() + DELIVERY_CLAIM_SECONDS * 1000).toISOString();
  const inserted = await db
    .prepare(
      `insert or ignore into telegram_deliveries (alert_id, chat_id, status, claimed_until, attempt_count, delivered_at, error, updated_at)
       values (?, ?, 'claimed', ?, 1, null, null, ?)`,
    )
    .bind(alertId, chatId, claimedUntil, now)
    .run();

  if (getRowsWritten(inserted) > 0) {
    return true;
  }

  const existing = await db
    .prepare(
      `select status, delivered_at, claimed_until
       from telegram_deliveries
       where alert_id = ? and chat_id = ?`,
    )
    .bind(alertId, chatId)
    .first<DeliveryRecord>();

  if (!existing || existing.delivered_at || existing.status === "permanent_failed") {
    return false;
  }

  if (existing.claimed_until && new Date(existing.claimed_until).valueOf() > Date.now()) {
    return false;
  }

  const updated = await db
    .prepare(
      `update telegram_deliveries
       set status = 'claimed', claimed_until = ?, attempt_count = attempt_count + 1, updated_at = ?
       where alert_id = ? and chat_id = ? and delivered_at is null`,
    )
    .bind(claimedUntil, now, alertId, chatId)
    .run();

  return getRowsWritten(updated) > 0;
};

export const recordDeliverySuccess = async (env: Env, alertId: string, chatId: string): Promise<void> => {
  await requireDb(env)
    .prepare(
      `update telegram_deliveries
       set status = 'delivered', delivered_at = ?, claimed_until = null, error = null, updated_at = ?
       where alert_id = ? and chat_id = ?`,
    )
    .bind(nowIso(), nowIso(), alertId, chatId)
    .run();
};

export const recordDeliveryFailure = async (
  env: Env,
  alertId: string,
  chatId: string,
  error: string,
  permanent: boolean,
): Promise<void> => {
  const status = permanent ? "permanent_failed" : "retryable_error";
  const now = nowIso();
  const db = requireDb(env);

  await db
    .prepare(
      `update telegram_deliveries
       set status = ?, claimed_until = null, error = ?, updated_at = ?
       where alert_id = ? and chat_id = ?`,
    )
    .bind(status, error, now, alertId, chatId)
    .run();

  await db
    .prepare(
      `update telegram_subscriptions
       set failure_count = failure_count + 1,
           last_delivery_error = ?,
           last_delivery_error_at = ?,
           status = case when ? then 'disabled' else status end
       where chat_id = ?`,
    )
    .bind(error, now, permanent ? 1 : 0, chatId)
    .run();
};
