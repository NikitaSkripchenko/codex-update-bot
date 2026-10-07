import { appendRecentDecision, createInitialMonitorState, getLatestActiveReset, hasActiveReset, normalizeMonitorState } from "../src/state";

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
        verdict: "not_reset",
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

  it.each(["reset_confirmed", "banked_reset"] as const)("keeps %s active for 24 hours", (verdict) => {
    const publishedAt = new Date("2026-07-10T12:00:00.000Z").valueOf();
    const state = {
      ...createInitialMonitorState(),
      recentDecisions: [
        {
          tweetId: "1",
          tweetUrl: "url-1",
          tweetCreatedAt: "2026-07-10T12:00:00.000Z",
          verdict,
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

  it("reads legacy uncertain decisions as not_reset without dropping them", () => {
    const state = normalizeMonitorState({ recentDecisions: [{
      tweetId: "legacy", tweetUrl: "https://x.com/sama/status/1", verdict: "uncertain",
      rationale: "Missing context", probabilities: { reset_confirmed: 0.1, not_reset: 0.2, uncertain: 0.7 },
    }] });
    expect(state.recentDecisions[0]).toMatchObject({ tweetId: "legacy", verdict: "not_reset", rationale: "Missing context" });
    expect(state.recentDecisions[0]?.probabilities).toBeUndefined();
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
