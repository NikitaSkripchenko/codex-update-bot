import { deliverToRecipients, forEachActiveSubscriberChatBatch } from "../src/alert-delivery";
import type { TelegramSendResult } from "../src/telegram";

describe("alert delivery", () => {
  it("aggregates delivered, permanent, and retryable recipient outcomes", async () => {
    const result = await deliverToRecipients(
      ["delivered", "blocked", "temporary"],
      async (chatId): Promise<TelegramSendResult> => {
        if (chatId === "delivered") return { ok: true, status: 200 };
        if (chatId === "blocked") return { ok: false, status: 403, error: "blocked", permanent: true, retryable: false };
        return { ok: false, status: 503, error: "temporary", permanent: false, retryable: true };
      },
    );

    expect(result).toEqual({ deliveredCount: 1, permanentFailureCount: 1, retryableErrors: ["temporary"] });
  });

  it("does not send to a recipient rejected by the claim hook", async () => {
    const sent: string[] = [];
    const result = await deliverToRecipients(
      ["busy", "ready"],
      (chatId) => {
        sent.push(chatId);
        return { ok: true, status: 200 };
      },
      { shouldDeliver: async (chatId) => chatId === "ready" },
    );

    expect(sent).toEqual(["ready"]);
    expect(result.deliveredCount).toBe(1);
  });

  it("forwards successful and failed outcomes to their hooks", async () => {
    const successes: string[] = [];
    const failures: Array<{ chatId: string; error: string; permanent: boolean; retryable: boolean }> = [];

    await deliverToRecipients(
      ["successful", "failed"],
      (chatId): TelegramSendResult =>
        chatId === "successful"
          ? { ok: true, status: 200 }
          : { ok: false, status: 403, error: "blocked", permanent: true, retryable: false },
      {
        onSuccess: (chatId) => {
          successes.push(chatId);
        },
        onFailure: (chatId, result) => {
          failures.push({
            chatId,
            error: result.error,
            permanent: result.permanent,
            retryable: result.retryable,
          });
        },
      },
    );

    expect(successes).toEqual(["successful"]);
    expect(failures).toEqual([
      { chatId: "failed", error: "blocked", permanent: true, retryable: false },
    ]);
  });

  it("keeps retryable errors bare by default and can format them with chat IDs", async () => {
    const bare = await deliverToRecipients(["temporary"], async (): Promise<TelegramSendResult> => ({
      ok: false,
      status: 503,
      error: "temporary",
      permanent: false,
      retryable: true,
    }));

    const formatted = await deliverToRecipients(
      ["temporary"],
      async (): Promise<TelegramSendResult> => ({
        ok: false,
        status: 503,
        error: "temporary",
        permanent: false,
        retryable: true,
      }),
      {
        formatRetryableError: (chatId, result) => `${chatId}: ${result.error}`,
      },
    );

    expect(bare.retryableErrors).toEqual(["temporary"]);
    expect(formatted.retryableErrors).toEqual(["temporary: temporary"]);
  });

  it("adds a trailing delay only when explicitly requested", async () => {
    vi.useFakeTimers();
    const sent: string[] = [];

    const processing = deliverToRecipients(
      ["solo"],
      async (chatId): Promise<TelegramSendResult> => {
        sent.push(chatId);
        return { ok: true, status: 200 };
      },
      {
        delayMs: 25,
        includeTrailingDelay: true,
      },
    );

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(24);
    expect(sent).toEqual(["solo"]);

    let settled = false;
    void processing.then(() => {
      settled = true;
    });
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await processing;
    expect(settled).toBe(true);
    vi.useRealTimers();
  });

  it("chunks active subscriber chats across pages of 500 into batches of 100", async () => {
    const pages = new Map<number, string[]>([
      [0, Array.from({ length: 250 }, (_, index) => `chat-${index + 1}`)],
      [250, Array.from({ length: 250 }, (_, index) => `chat-${index + 251}`)],
    ]);

    const env = {
      MONITOR_STATE: {} as KVNamespace,
      SUBSCRIPTIONS_DB: {
        prepare: (query: string) => ({
          bind: (...values: unknown[]) => ({
            all: async () => {
              if (!query.includes("select chat_id")) {
                return { results: [] };
              }

              const offset = Number(values[1]);
              return { results: (pages.get(offset) || []).map((chat_id) => ({ chat_id })) };
            },
          }),
        }),
      } as unknown as D1Database,
    };

    const batches: string[][] = [];

    await forEachActiveSubscriberChatBatch(env, async (chatIds) => {
      batches.push(chatIds);
    });

    expect(batches).toHaveLength(6);
    expect(batches.map((batch) => batch.length)).toEqual([100, 100, 50, 100, 100, 50]);
    expect(batches[0]?.[0]).toBe("chat-1");
    expect(batches[2]?.[0]).toBe("chat-201");
    expect(batches[3]?.[0]).toBe("chat-251");
    expect(batches[5]?.[0]).toBe("chat-451");
  });
});
