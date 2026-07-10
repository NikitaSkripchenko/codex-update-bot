import { runMonitor } from "../src/monitor";
import { readMonitorState, writeMonitorState } from "../src/state";
import type { Env, Tweet } from "../src/types";
import { createMemoryKv } from "./memory-kv";

const createTweet = (id: string, authorUsername = "thsottiaux"): Tweet => ({
  id,
  url: `https://x.com/${authorUsername}/status/${id}`,
  createdAt: "2026-07-07T12:00:00.000Z",
  fullText: `tweet ${id}`,
  authorUsername,
  isRetweet: false,
  isReply: false,
});

const createEnv = (): Env => ({
  MONITOR_STATE: createMemoryKv(),
});

describe("monitor", () => {
  it("seeds the watermark on first run without alerting historical tweets", async () => {
    const env = createEnv();
    const dispatched: string[] = [];
    const outcome = await runMonitor(env, {
      fetchTweets: async () => [createTweet("1"), createTweet("2")],
      classify: async () => ({ verdict: "not_reset", confidence: 0.9, rationale: "no" }),
      dispatch: async (_env, tweet) => {
        dispatched.push(tweet.id);
        return { mode: "direct", deliveredCount: 1, permanentFailureCount: 0 };
      },
    });

    const state = await readMonitorState(env.MONITOR_STATE);
    expect(outcome.outcome).toBe("seeded");
    expect(state.lastSeenTweetId).toBe("2");
    expect(state.recentDecisions.map((decision) => decision.tweetId)).toEqual(["2", "1"]);
    expect(state.recentDecisions[0]?.deliveryMode).toBe("cached");
    expect(dispatched).toEqual([]);
  });

  it("classifies, dispatches, and advances only unseen tweets", async () => {
    const env = createEnv();
    await runMonitor(env, {
      fetchTweets: async () => [createTweet("1"), createTweet("2")],
      classify: async () => ({ verdict: "not_reset", confidence: 0.9, rationale: "no" }),
      dispatch: async () => ({ mode: "direct", deliveredCount: 1, permanentFailureCount: 0 }),
    });

    const dispatched: string[] = [];
    const outcome = await runMonitor(env, {
      fetchTweets: async () => [createTweet("1"), createTweet("2"), createTweet("3"), createTweet("4")],
      classify: async () => ({ verdict: "reset_confirmed", confidence: 0.95, rationale: "yes" }),
      dispatch: async (_env, tweet) => {
        dispatched.push(tweet.id);
        return { mode: "queued", queuedCount: 10 };
      },
    });

    const state = await readMonitorState(env.MONITOR_STATE);
    expect(outcome).toMatchObject({ outcome: "processed", processedCount: 2, lastSeenTweetId: "4" });
    expect(dispatched).toEqual(["3", "4"]);
    expect(state.recentDecisions[0]?.tweetId).toBe("4");
    expect(state.recentDecisions[1]?.tweetId).toBe("3");
  });

  it("classifies and caches unseen non-reset tweets without dispatching", async () => {
    const env = createEnv();
    await runMonitor(env, {
      fetchTweets: async () => [createTweet("1"), createTweet("2")],
      classify: async () => ({ verdict: "not_reset", confidence: 0.9, rationale: "no" }),
      dispatch: async () => ({ mode: "direct", deliveredCount: 1, permanentFailureCount: 0 }),
    });

    const dispatched: string[] = [];
    const outcome = await runMonitor(env, {
      fetchTweets: async () => [createTweet("1"), createTweet("2"), createTweet("3"), createTweet("4")],
      classify: async () => ({ verdict: "not_reset", confidence: 0.95, rationale: "still no" }),
      dispatch: async (_env, tweet) => {
        dispatched.push(tweet.id);
        return { mode: "queued", queuedCount: 10 };
      },
    });

    const state = await readMonitorState(env.MONITOR_STATE);
    expect(outcome).toMatchObject({ outcome: "processed", processedCount: 2, lastSeenTweetId: "4" });
    expect(dispatched).toEqual([]);
    expect(state.recentDecisions[0]?.tweetId).toBe("4");
    expect(state.recentDecisions[0]?.deliveryMode).toBe("cached");
    expect(state.recentDecisions[0]?.tweetText).toBe("tweet 4");
  });

  it("monitors every configured target username", async () => {
    const env = {
      ...createEnv(),
      TARGET_USERNAMES: "thsottiaux,sama",
    };
    await runMonitor(env, {
      fetchTweets: async () => [createTweet("1"), createTweet("2", "sama")],
      classify: async () => ({ verdict: "not_reset", confidence: 0.9, rationale: "no" }),
      dispatch: async () => ({ mode: "direct", deliveredCount: 1, permanentFailureCount: 0 }),
    });

    const dispatched: string[] = [];
    const outcome = await runMonitor(env, {
      fetchTweets: async () => [createTweet("1"), createTweet("2", "sama"), createTweet("3"), createTweet("4", "sama")],
      classify: async () => ({ verdict: "reset_confirmed", confidence: 0.95, rationale: "yes" }),
      dispatch: async (_env, tweet) => {
        dispatched.push(tweet.url);
        return { mode: "queued", queuedCount: 10 };
      },
    });

    expect(outcome).toMatchObject({ outcome: "processed", processedCount: 2, lastSeenTweetId: "4" });
    expect(dispatched).toEqual(["https://x.com/thsottiaux/status/3", "https://x.com/sama/status/4"]);
  });

  it("does not advance the watermark when dispatch fails", async () => {
    const env = createEnv();
    await runMonitor(env, {
      fetchTweets: async () => [createTweet("1")],
      classify: async () => ({ verdict: "not_reset", confidence: 0.9, rationale: "no" }),
      dispatch: async () => ({ mode: "direct", deliveredCount: 1, permanentFailureCount: 0 }),
    });

    await expect(
      runMonitor(env, {
        fetchTweets: async () => [createTweet("1"), createTweet("2")],
        classify: async () => ({ verdict: "reset_confirmed", confidence: 0.9, rationale: "yes" }),
        dispatch: async () => {
          throw new Error("telegram down");
        },
      }),
    ).rejects.toThrow("telegram down");

    const state = await readMonitorState(env.MONITOR_STATE);
    expect(state.lastSeenTweetId).toBe("1");
    expect(state.lastError).toContain("telegram down");
  });

  it("backfills stale provider jumps without dispatching historical alerts", async () => {
    const env = createEnv();
    const staleRettiwtTweet = {
      ...createTweet("1991291685343760850"),
      createdAt: "2025-11-19T23:45:08.000Z",
    };
    await runMonitor(env, {
      fetchTweets: async () => [staleRettiwtTweet],
      classify: async () => ({ verdict: "not_reset", confidence: 0.9, rationale: "old" }),
      dispatch: async () => ({ mode: "direct", deliveredCount: 1, permanentFailureCount: 0 }),
    });

    const dispatched: string[] = [];
    const oldButNewlyVisible = {
      ...createTweet("2074705681920520526"),
      createdAt: "2026-07-08T04:02:35.000Z",
    };
    const outcome = await runMonitor(env, {
      fetchTweets: async () => [staleRettiwtTweet, oldButNewlyVisible],
      classify: async () => ({ verdict: "not_reset", confidence: 0.8, rationale: "cached" }),
      dispatch: async (_env, tweet) => {
        dispatched.push(tweet.id);
        return { mode: "direct", deliveredCount: 1, permanentFailureCount: 0 };
      },
    });

    const state = await readMonitorState(env.MONITOR_STATE);
    expect(outcome).toMatchObject({
      outcome: "no_new_tweets",
      processedCount: 0,
      lastSeenTweetId: "2074705681920520526",
    });
    expect(dispatched).toEqual([]);
    expect(state.recentDecisions[0]?.tweetId).toBe("2074705681920520526");
    expect(state.recentDecisions[0]?.deliveryMode).toBe("cached");
  });

  it("repairs invalid saved watermarks by reseeding without dispatching", async () => {
    const env = createEnv();
    await writeMonitorState(env.MONITOR_STATE, {
      lastSeenTweetId: "https://rss.xcancel.com/thsottiaux/rss",
      lastSeenTweetUrl: "https://x.com/thsottiaux/rss",
      lastCheckAt: "2026-07-08T10:17:00.000Z",
      lastError: null,
      recentDecisions: [],
    });

    const dispatched: string[] = [];
    const outcome = await runMonitor(env, {
      fetchTweets: async () => [createTweet("2074705681920520526")],
      classify: async () => ({ verdict: "not_reset", confidence: 0.8, rationale: "cached" }),
      dispatch: async (_env, tweet) => {
        dispatched.push(tweet.id);
        return { mode: "direct", deliveredCount: 1, permanentFailureCount: 0 };
      },
    });

    const state = await readMonitorState(env.MONITOR_STATE);
    expect(outcome).toMatchObject({
      outcome: "seeded",
      processedCount: 0,
      lastSeenTweetId: "2074705681920520526",
    });
    expect(dispatched).toEqual([]);
    expect(state.lastSeenTweetId).toBe("2074705681920520526");
    expect(state.recentDecisions[0]?.deliveryMode).toBe("cached");
  });

  it("backfills missing cached decisions for an already-seeded dashboard without dispatching", async () => {
    const env = createEnv();
    await writeMonitorState(env.MONITOR_STATE, {
      lastSeenTweetId: "3",
      lastSeenTweetUrl: "https://x.com/thsottiaux/status/3",
      lastCheckAt: "2026-07-08T10:17:00.000Z",
      lastError: null,
      recentDecisions: [],
    });

    const classified: string[] = [];
    const dispatched: string[] = [];
    const outcome = await runMonitor(env, {
      fetchTweets: async () => [createTweet("1"), createTweet("2"), createTweet("3")],
      classify: async (_env, tweet) => {
        classified.push(tweet.id);
        return { verdict: "not_reset", confidence: 0.8, rationale: "cached" };
      },
      dispatch: async (_env, tweet) => {
        dispatched.push(tweet.id);
        return { mode: "direct", deliveredCount: 1, permanentFailureCount: 0 };
      },
    });

    const state = await readMonitorState(env.MONITOR_STATE);
    expect(outcome).toMatchObject({ outcome: "no_new_tweets", processedCount: 0, lastSeenTweetId: "3" });
    expect(classified).toEqual(["1", "2", "3"]);
    expect(dispatched).toEqual([]);
    expect(state.recentDecisions.map((decision) => decision.tweetId)).toEqual(["3", "2", "1"]);
  });
});
