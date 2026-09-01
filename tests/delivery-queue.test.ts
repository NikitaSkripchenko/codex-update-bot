import { dispatchAlert, dispatchSubscriberAlertNow, processDeliveryBatch } from "../src/delivery-queue";
import type { Env } from "../src/types";

const createSubscriptionsDb = (): D1Database => {
  let listed = false;

  return {
    prepare: (query: string) => ({
      bind: (..._values: unknown[]) => ({
        all: async () => {
          if (query.includes("select chat_id")) {
            if (listed) {
              return { results: [] };
            }

            listed = true;
            return { results: [{ chat_id: "123" }, { chat_id: "456" }] };
          }

          return { results: [] };
        },
        run: async () => ({ meta: { rows_written: 1 } }),
      }),
    }),
  } as unknown as D1Database;
};

describe("subscriber alert delivery", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("delivers a reset transition directly to active subscribers", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock as typeof fetch);
    const env: Env = {
      MONITOR_STATE: {} as KVNamespace,
      SUBSCRIPTIONS_DB: createSubscriptionsDb(),
      TELEGRAM_BOT_TOKEN: "telegram-token",
    };

    const result = await dispatchSubscriberAlertNow(
      env,
      {
        id: "1",
        url: "https://x.com/thsottiaux/status/1",
        createdAt: "2026-07-10T12:00:00.000Z",
        fullText: "Codex limits are reset.",
        authorUsername: "thsottiaux",
        isReply: false,
        isRetweet: false,
      },
      { verdict: "reset_confirmed", confidence: 0.96, rationale: "Limits are reset." },
    );

    expect(result).toEqual({ mode: "direct", deliveredCount: 2, permanentFailureCount: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/sendMessage");
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("/sendMessage");
  });

  it("reports private direct delivery with permanent failures preserved in counts", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: false, description: "Forbidden: bot was blocked by the user" }), {
          status: 403,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const env: Env = {
      MONITOR_STATE: {} as KVNamespace,
      TELEGRAM_BOT_TOKEN: "telegram-token",
      TELEGRAM_CHAT_IDS: "123,456",
    };

    const result = await dispatchAlert(
      env,
      {
        id: "1",
        url: "https://x.com/thsottiaux/status/1",
        createdAt: "2026-07-10T12:00:00.000Z",
        fullText: "Codex limits are reset.",
        authorUsername: "thsottiaux",
        isReply: false,
        isRetweet: false,
      },
      { verdict: "reset_confirmed", confidence: 0.96, rationale: "Limits are reset." },
    );

    expect(result).toEqual({ mode: "direct", deliveredCount: 1, permanentFailureCount: 1 });
  });

  it("retries a queue message when Telegram returns a retryable failure", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ ok: false, description: "upstream unavailable" }), { status: 503 }),
    );
    vi.stubGlobal("fetch", fetchMock as typeof fetch);

    const ack = vi.fn();
    const retry = vi.fn();
    const env: Env = {
      MONITOR_STATE: {} as KVNamespace,
      SUBSCRIPTIONS_DB: createSubscriptionsDb(),
      TELEGRAM_BOT_TOKEN: "telegram-token",
      TELEGRAM_SEND_DELAY_MS: "0",
    };

    await processDeliveryBatch(
      {
        messages: [
          {
            ack,
            body: {
              alertId: "1:reset_confirmed",
              chatIds: ["123"],
              classification: { verdict: "reset_confirmed", confidence: 0.96, rationale: "Limits are reset." },
              tweet: {
                id: "1",
                url: "https://x.com/thsottiaux/status/1",
                createdAt: "2026-07-10T12:00:00.000Z",
                fullText: "Codex limits are reset.",
                authorUsername: "thsottiaux",
                isReply: false,
                isRetweet: false,
              },
            },
            id: "message-1",
            retry,
          },
        ],
      } as MessageBatch<{
        alertId: string;
        chatIds: string[];
        classification: { verdict: "reset_confirmed"; confidence: number; rationale: string };
        tweet: {
          id: string;
          url: string;
          createdAt: string;
          fullText: string;
          authorUsername: string;
          isReply: boolean;
          isRetweet: boolean;
        };
      }>,
      env,
    );

    expect(retry).toHaveBeenCalledTimes(1);
    expect(ack).not.toHaveBeenCalled();
  });
});
