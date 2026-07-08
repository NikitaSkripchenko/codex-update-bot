import { formatAlertMessage, formatStatusMessage, parseTelegramChatIds, setTelegramCommands, truncateForTelegram } from "../src/telegram";

describe("telegram", () => {
  it("parses comma-separated chat IDs", () => {
    expect(parseTelegramChatIds({ TELEGRAM_CHAT_IDS: "123, -456, ,789" })).toEqual(["123", "-456", "789"]);
  });

  it("formats bounded alert messages", () => {
    const text = formatAlertMessage(
      {
        id: "1",
        url: "https://x.com/thsottiaux/status/1",
        createdAt: "2026-07-07T12:00:00.000Z",
        fullText: "x".repeat(2000),
        authorUsername: "thsottiaux",
        isRetweet: false,
        isReply: false,
      },
      {
        verdict: "reset_confirmed",
        confidence: 0.93,
        rationale: "The post confirms reset.",
      },
    );

    expect(text).toContain("RESET CONFIRMED");
    expect(text.length).toBeLessThanOrEqual(3900);
  });

  it("truncates long strings", () => {
    expect(truncateForTelegram("abcdef", 5)).toBe("ab...");
  });

  it("includes latest cached tweet text in status", () => {
    const text = formatStatusMessage({
      lastSeenTweetId: "1",
      lastSeenTweetUrl: "https://x.com/thsottiaux/status/1",
      lastCheckAt: "2026-07-07T12:00:00.000Z",
      lastError: null,
      recentDecisions: [
        {
          alertedAt: "2026-07-07T12:00:01.000Z",
          confidence: 0.9,
          deliveryMode: "cached",
          rationale: "not a reset",
          tweetCreatedAt: "2026-07-07T12:00:00.000Z",
          tweetId: "1",
          tweetText: "latest cached tweet",
          tweetUrl: "https://x.com/thsottiaux/status/1",
          verdict: "not_reset",
        },
      ],
    });

    expect(text).toContain("Latest post: https://x.com/thsottiaux/status/1");
    expect(text).toContain("latest cached tweet");
  });

  it("sets Telegram UI commands", async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const result = await setTelegramCommands({ TELEGRAM_BOT_TOKEN: "token" }, (async (input, init) => {
      calls.push({ input, init });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch);

    expect(result.ok).toBe(true);
    expect(String(calls[0]?.input)).toContain("/setMyCommands");
    expect(JSON.parse(String(calls[0]?.init?.body)).commands).toEqual(
      expect.arrayContaining([expect.objectContaining({ command: "status" })]),
    );
  });
});
