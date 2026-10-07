import { getAlertId, dispatchAlert, dispatchSubscriberAlertNow, processDeliveryBatch } from "../src/delivery-queue";
import type { DeliveryQueueMessage, Env } from "../src/types";

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

const createDeliveryBatch = (message: {
  ack: ReturnType<typeof vi.fn>;
  body: DeliveryQueueMessage;
  id: string;
  retry: ReturnType<typeof vi.fn>;
}): MessageBatch<DeliveryQueueMessage> =>
  ({
    ackAll: vi.fn(),
    messages: [message],
    metadata: {},
    queue: "telegram-delivery",
    retryAll: vi.fn(),
  }) as unknown as MessageBatch<DeliveryQueueMessage>;

describe("subscriber alert delivery", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses the same delivery ledger ID for both successful reset categories", () => {
    const tweet = { id: "1", url: "url", createdAt: "", fullText: "", authorUsername: "sama", isReply: false, isRetweet: false };
    expect(getAlertId(tweet, { verdict: "banked_reset", confidence: 0.9, rationale: "Banked usage" })).toBe("1:reset_confirmed");
    expect(getAlertId(tweet, { verdict: "reset_confirmed", confidence: 0.9, rationale: "Reset" })).toBe("1:reset_confirmed");
  });

  it.each(["reset_confirmed", "banked_reset"] as const)("delivers %s directly to active subscribers", async (verdict) => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ ok: true }), { status: 200 }));
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
      { verdict, confidence: 0.96, rationale: "Limits are reset." },
    );

    expect(result).toEqual({ mode: "direct", deliveredCount: 2, permanentFailureCount: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/sendPhoto");
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("/sendPhoto");
    const form = fetchMock.mock.calls[0]?.[1]?.body as FormData;
    expect(form.get("caption")).toContain("Codex limit reset");
    expect(form.get("caption")).toContain("View post from @thsottiaux");
    expect(String(form.get("caption")).length).toBeLessThanOrEqual(1024);
    const photo = form.get("photo");
    expect(photo).toBeInstanceOf(Blob);
    expect((photo as unknown as Blob).size).toBeGreaterThan(100_000);
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
      createDeliveryBatch({
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
      }),
      env,
    );

    expect(retry).toHaveBeenCalledTimes(1);
    expect(ack).not.toHaveBeenCalled();
  });

  it("keeps queue delivery pending through the trailing send delay for a single recipient", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock as typeof fetch);

    const ack = vi.fn();
    const retry = vi.fn();
    const env: Env = {
      MONITOR_STATE: {} as KVNamespace,
      SUBSCRIPTIONS_DB: createSubscriptionsDb(),
      TELEGRAM_BOT_TOKEN: "telegram-token",
      TELEGRAM_SEND_DELAY_MS: "25",
    };

    const processing = processDeliveryBatch(
      createDeliveryBatch({
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
        id: "message-2",
        retry,
      }),
      env,
    );

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(24);
    expect(ack).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await processing;

    expect(ack).toHaveBeenCalledTimes(1);
    expect(retry).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
