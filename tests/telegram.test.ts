import {
  formatAlertMessage,
  formatHelpMessage,
  formatStatusMessage,
  getTelegramCommandReplyMarkup,
  parseTelegramChatIds,
  setTelegramCommands,
  truncateForTelegram,
} from "../src/telegram";

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

    expect(text).toContain("<b>Codex limit reset</b>");
    expect(text).toContain("✅ Reset confirmed");
    expect(text).toContain('href="https://x.com/thsottiaux/status/1"');
    expect(text).toContain("<blockquote expandable>");
    expect(text.length).toBeLessThanOrEqual(3900);
  });

  it("hides provider diagnostics from heuristic fallback alerts", () => {
    const text = formatAlertMessage(
      {
        id: "1",
        url: "https://x.com/thsottiaux/status/1",
        createdAt: "2026-07-07T12:00:00.000Z",
        fullText: "Reset has been propagated to accounts.",
        authorUsername: "thsottiaux",
        isRetweet: false,
        isReply: false,
      },
      {
        verdict: "reset_confirmed",
        confidence: 0.62,
        rationale:
          "OpenRouter returned an empty classification response; The quoted post explicitly says limits were reset.",
      },
    );

    expect(text).toContain("The quoted post explicitly says limits were reset.");
    expect(text).not.toContain("OpenRouter returned");
  });

  it("truncates long strings", () => {
    expect(truncateForTelegram("abcdef", 5)).toBe("ab...");
  });

  it("reports an inactive reset status alongside the latest monitored post", () => {
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

    expect(text).toContain("<b>Reset status</b>: ❌ Inactive (no reset was confirmed within the last 24 hours)");
    expect(text).toContain("<b>Latest monitored post</b>");
    expect(text).toContain('href="https://x.com/thsottiaux/status/1"');
    expect(text).not.toContain("latest cached tweet");
  });

  it("shows the latest reset-confirming post", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-10T12:00:00.000Z"));

    const text = formatStatusMessage(
      {
        lastSeenTweetId: "newest",
        lastSeenTweetUrl: "https://x.com/thsottiaux/status/newest",
        lastCheckAt: "2026-07-10T12:00:00.000Z",
        lastError: null,
        recentDecisions: [
          {
            alertedAt: "2026-07-09T12:00:00.000Z",
            confidence: 0.8,
            deliveryMode: "cached",
            rationale: "old result",
            tweetCreatedAt: "2026-07-08T11:00:00.000Z",
            tweetId: "old",
            tweetText: "old cached tweet",
            tweetUrl: "https://x.com/thsottiaux/status/old",
            verdict: "not_reset",
          },
          {
            alertedAt: "2026-07-10T12:00:00.000Z",
            confidence: 0.95,
            deliveryMode: "cached",
            rationale: "new result",
            tweetCreatedAt: "2026-07-10T11:00:00.000Z",
            tweetId: "newest",
            tweetText: "newest cached tweet",
            tweetUrl: "https://x.com/thsottiaux/status/newest",
            verdict: "reset_confirmed",
          },
        ],
      },
    );

    expect(text).toContain("https://x.com/thsottiaux/status/newest");
    expect(text).not.toContain("Today's results");
    expect(text).not.toContain("Delivery");
    expect(text).not.toContain("Last error");
    expect(text).toContain("<b>Reset status</b>: ✅ Active (a reset was confirmed within the last 24 hours)");
    expect(text).toContain("View confirming post");
    expect(text).toContain("<b>Latest post verdict</b>: ✅ Reset confirmed");
    vi.useRealTimers();
  });

  it("uses an earlier reset confirmation instead of a newer unrelated post", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-10T12:00:00.000Z"));

    const text = formatStatusMessage({
      lastSeenTweetId: "newest",
      lastSeenTweetUrl: "https://x.com/thsottiaux/status/newest",
      lastCheckAt: "2026-07-10T12:00:00.000Z",
      lastError: null,
      recentDecisions: [
        { tweetId: "newest", tweetUrl: "https://x.com/thsottiaux/status/newest", tweetCreatedAt: "2026-07-10T11:59:00.000Z", verdict: "not_reset", confidence: 0.9, rationale: "unrelated", alertedAt: "", deliveryMode: "cached" },
        { tweetId: "reset", tweetUrl: "https://x.com/thsottiaux/status/reset", tweetCreatedAt: "2026-07-09T13:00:00.000Z", verdict: "reset_confirmed", confidence: 0.9, rationale: "confirmed", alertedAt: "", deliveryMode: "direct" },
      ],
    });

    expect(text).toContain("<b>Reset status</b>: ✅ Active (a reset was confirmed within the last 24 hours)");
    expect(text).toContain("https://x.com/thsottiaux/status/reset");
    expect(text).toContain("https://x.com/thsottiaux/status/newest");
    expect(text).toContain("unrelated");
    vi.useRealTimers();
  });

  it("formats help as predictable chat guidance", () => {
    const text = formatHelpMessage(false);

    expect(text).toContain("<b>Codex limit reset alerts</b>");
    expect(text).toContain("<code>/status</code> shows cached results");
    expect(text).toContain("<code>/subscribe</code> - currently unavailable");
  });

  it("keeps Telegram command keyboard action-oriented", () => {
    expect(getTelegramCommandReplyMarkup()).toMatchObject({
      input_field_placeholder: "Tap a command or type /status",
      keyboard: [["/status"], ["/subscribe", "/unsubscribe"], ["/help"]],
    });
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
