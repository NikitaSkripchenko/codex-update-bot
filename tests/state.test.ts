import { appendRecentDecision, createInitialMonitorState } from "../src/state";

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
});
