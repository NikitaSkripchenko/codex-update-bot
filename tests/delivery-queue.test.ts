import { dispatchSubscriberAlertNow } from "../src/delivery-queue";
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
            return { results: [{ chat_id: "123" }] };
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

    expect(result).toEqual({ mode: "direct", deliveredCount: 1, permanentFailureCount: 0 });
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/sendMessage");
  });
});
