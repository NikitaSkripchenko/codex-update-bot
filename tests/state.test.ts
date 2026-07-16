import { appendRecentDecision, createInitialMonitorState, getLatestActiveReset, hasActiveReset } from "../src/state";

describe("state", () => {
  it("keeps bounded recent decisions and replaces decisions for the same tweet", () => {
    const state = createInitialMonitorState();
    const first = appendRecentDecision(
      state,
      {
        tweetId: "1",
        tweetUrl: "url-1",
        tweetCreatedAt: "created",
        verdict: "not_reset",
        confidence: 0.8,
        rationale: "no",
        alertedAt: "later",
        deliveryMode: "direct",
      },
      2,
    );
    const second = appendRecentDecision(
      first,
      {
        tweetId: "2",
        tweetUrl: "url-2",
        tweetCreatedAt: "created",
        verdict: "uncertain",
        confidence: 0.4,
        rationale: "maybe",
        alertedAt: "later",
        deliveryMode: "direct",
      },
      2,
    );
    const third = appendRecentDecision(
      second,
      {
        tweetId: "1",
        tweetUrl: "url-1b",
        tweetCreatedAt: "created",
        verdict: "reset_confirmed",
        confidence: 0.9,
        rationale: "still no",
        alertedAt: "later",
        deliveryMode: "queued",
        queuedCount: 3,
      },
      2,
    );

    expect(third.recentDecisions).toHaveLength(2);
    expect(third.recentDecisions.map((entry) => entry.tweetId)).toEqual(["1", "2"]);
    expect(third.recentDecisions[0]?.tweetUrl).toBe("url-1b");
    expect(third.recentDecisions[0]?.verdict).toBe("reset_confirmed");
  });

  it("keeps the reset verdict true for 24 hours after a confirmed tweet is published", () => {
    const publishedAt = new Date("2026-07-10T12:00:00.000Z").valueOf();
    const state = {
      ...createInitialMonitorState(),
      recentDecisions: [
        {
          tweetId: "1",
          tweetUrl: "url-1",
          tweetCreatedAt: "2026-07-10T12:00:00.000Z",
          verdict: "reset_confirmed" as const,
          confidence: 0.9,
          rationale: "confirmed",
          alertedAt: "2026-07-10T12:00:01.000Z",
          deliveryMode: "direct" as const,
        },
      ],
    };

    expect(hasActiveReset(state, publishedAt + 23 * 60 * 60 * 1000)).toBe(true);
    expect(hasActiveReset(state, publishedAt + 24 * 60 * 60 * 1000)).toBe(false);
  });

  it("returns the most recent confirmed reset within the active window", () => {
    const state = {
      ...createInitialMonitorState(),
      recentDecisions: [
        { tweetId: "old", tweetUrl: "url-old", tweetCreatedAt: "2026-07-10T10:00:00.000Z", verdict: "reset_confirmed" as const, confidence: 0.9, rationale: "old", alertedAt: "", deliveryMode: "direct" as const },
        { tweetId: "latest", tweetUrl: "url-latest", tweetCreatedAt: "2026-07-10T11:00:00.000Z", verdict: "reset_confirmed" as const, confidence: 0.9, rationale: "latest", alertedAt: "", deliveryMode: "direct" as const },
      ],
    };

    expect(getLatestActiveReset(state, new Date("2026-07-10T12:00:00.000Z").valueOf())?.tweetId).toBe("latest");
  });
});
