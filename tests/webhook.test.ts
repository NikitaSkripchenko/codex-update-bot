import { handleTelegramWebhook } from "../src/webhook";
import type { Env } from "../src/types";
import { createMemoryKv } from "./memory-kv";

const createEnv = (): Env => ({
  MONITOR_STATE: createMemoryKv(),
  TELEGRAM_BOT_TOKEN: "token",
  TELEGRAM_WEBHOOK_SECRET: "secret",
});

type SubscriptionRow = {
  chat_id: string;
  chat_type: string;
  status: string;
  subscribed_at: string;
  unsubscribed_at: string | null;
  failure_count: number;
  last_delivery_error: string | null;
  last_delivery_error_at: string | null;
};

class MemorySubscriptionsDb {
  readonly rows = new Map<string, SubscriptionRow>();
  writes = 0;

  prepare(query: string): D1PreparedStatement {
    const db = this;
    const normalizedQuery = query.replace(/\s+/g, " ").toLowerCase();

    return {
      bind(...params: unknown[]) {
        return {
          async first<T>() {
            if (normalizedQuery.includes("select status from telegram_subscriptions where chat_id = ?")) {
              return (db.rows.get(String(params[0])) || null) as T | null;
            }

            return null;
          },
          async run() {
            if (normalizedQuery.includes("insert into telegram_subscriptions")) {
              const chatId = String(params[0]);
              db.rows.set(chatId, {
                chat_id: chatId,
                chat_type: String(params[1]),
                status: "active",
                subscribed_at: String(params[2]),
                unsubscribed_at: null,
                failure_count: 0,
                last_delivery_error: null,
                last_delivery_error_at: null,
              });
              db.writes += 1;
            }

            if (normalizedQuery.includes("update telegram_subscriptions set status = 'unsubscribed'")) {
              const chatId = String(params[1]);
              const existing = db.rows.get(chatId);

              if (existing) {
                db.rows.set(chatId, {
                  ...existing,
                  status: "unsubscribed",
                  unsubscribed_at: String(params[0]),
                });
                db.writes += 1;
              }
            }

            return { meta: { rows_written: 1 }, success: true } as D1Result;
          },
          async all<T>() {
            return { meta: {}, results: [] as T[], success: true } as D1Result<T>;
          },
        } as unknown as D1PreparedStatement;
      },
    } as unknown as D1PreparedStatement;
  }
}

const createWebhookRequest = (text: string, updateId = 1): Request =>
  new Request("https://worker.example/telegram/webhook", {
    body: JSON.stringify({
      message: {
        chat: {
          id: 123,
          type: "private",
        },
        message_id: 10,
        text,
      },
      update_id: updateId,
    }),
    headers: {
      "content-type": "application/json",
      "x-telegram-bot-api-secret-token": "secret",
    },
    method: "POST",
  });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("telegram webhook", () => {
  it("replies with useful guidance for unknown commands", async () => {
    const calls: Array<{ input: RequestInfo | URL; body: Record<string, unknown> }> = [];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({
          body: JSON.parse(String(init?.body || "{}")) as Record<string, unknown>,
          input,
        });

        return new Response(JSON.stringify({ ok: true, result: { message_id: calls.length } }), { status: 200 });
      }),
    );

    const response = await handleTelegramWebhook(createWebhookRequest("/wat"), createEnv());
    const body = (await response.json()) as { ok?: boolean };

    expect(body.ok).toBe(true);
    expect(String(calls[0]?.input)).toContain("/sendChatAction");
    expect(String(calls[1]?.input)).toContain("/sendMessage");
    expect(calls[1]?.body.parse_mode).toBe("HTML");
    expect(calls[1]?.body.text).toContain("I do not know <code>/wat</code>.");
    expect(calls[1]?.body.text).toContain("Try <code>/status</code> for the latest monitored post");
  });

  it("does not rewrite an already active subscription", async () => {
    const calls: Array<{ input: RequestInfo | URL; body: Record<string, unknown> }> = [];
    const db = new MemorySubscriptionsDb();
    const env = {
      ...createEnv(),
      PUBLIC_SUBSCRIPTIONS_ENABLED: "true",
      SUBSCRIPTIONS_DB: db as unknown as D1Database,
    };

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({
          body: JSON.parse(String(init?.body || "{}")) as Record<string, unknown>,
          input,
        });

        return new Response(JSON.stringify({ ok: true, result: { message_id: calls.length } }), { status: 200 });
      }),
    );

    await handleTelegramWebhook(createWebhookRequest("/subscribe", 1), env);
    await handleTelegramWebhook(createWebhookRequest("/subscribe", 2), env);

    const edits = calls.filter((call) => String(call.input).includes("/editMessageText"));
    expect(db.writes).toBe(1);
    expect(edits[0]?.body.text).toBe("<b>Subscribed</b>\nThis chat will receive future confirmed reset alerts.");
    expect(edits[1]?.body.text).toBe("<b>Already subscribed</b>\nThis chat will receive future confirmed reset alerts.");
  });

  it("does not rewrite an already inactive subscription", async () => {
    const calls: Array<{ input: RequestInfo | URL; body: Record<string, unknown> }> = [];
    const db = new MemorySubscriptionsDb();
    const env = {
      ...createEnv(),
      PUBLIC_SUBSCRIPTIONS_ENABLED: "true",
      SUBSCRIPTIONS_DB: db as unknown as D1Database,
    };

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({
          body: JSON.parse(String(init?.body || "{}")) as Record<string, unknown>,
          input,
        });

        return new Response(JSON.stringify({ ok: true, result: { message_id: calls.length } }), { status: 200 });
      }),
    );

    await handleTelegramWebhook(createWebhookRequest("/subscribe", 1), env);
    await handleTelegramWebhook(createWebhookRequest("/unsubscribe", 2), env);
    await handleTelegramWebhook(createWebhookRequest("/unsubscribe", 3), env);

    const edits = calls.filter((call) => String(call.input).includes("/editMessageText"));
    expect(db.writes).toBe(2);
    expect(edits[1]?.body.text).toBe("<b>Unsubscribed</b>\nThis chat will no longer receive reset alerts.");
    expect(edits[2]?.body.text).toBe("<b>Already unsubscribed</b>\nThis chat is not receiving reset alerts.");
  });
});
