import { runMonitor } from "../src/monitor";
import { readMonitorState, writeMonitorState } from "../src/state";
import type { Env, Tweet } from "../src/types";
import { createMemoryKv } from "./memory-kv";

const createTweet = (id: string, authorUsername = "thsottiaux"): Tweet => ({
  id,
  url: `https://x.com/${authorUsername}/status/${id}`,
  createdAt: new Date().toISOString(),
  fullText: `tweet ${id}`,
  authorUsername,
  isRetweet: false,
  isReply: false,
});

const createEnv = (): Env => ({
  MONITOR_STATE: createMemoryKv(),
});

describe("monitor", () => {
  it("persists parallel successes while another tweet is pending or fails, and retries missing seed decisions", async () => {
    const env = createEnv();
    let rejectSlow!: (error: Error) => void;
    const slow = new Promise<never>((_resolve, reject) => { rejectSlow = reject; });
    const classify = vi.fn(async (_env: Env, tweet: Tweet) => {
      if (tweet.id === "1") return slow;
      return { verdict: "not_reset" as const, confidence: 0.9, rationale: "ok" };
    });
    const deps = { classificationConcurrency: 3, fetchTweets: async () => [createTweet("1"), createTweet("2"), createTweet("3")], classify, dispatch: async () => ({ mode: "direct" as const, deliveredCount: 1, permanentFailureCount: 0 }) };
    const run = runMonitor(env, deps);
    await vi.waitFor(async () => expect((await readMonitorState(env.MONITOR_STATE)).recentDecisions).toHaveLength(2));
    expect(classify).toHaveBeenCalledTimes(3);
    const failed = expect(run).rejects.toThrow("provider failed");
    rejectSlow(new Error("provider failed"));
    await failed;
    expect((await readMonitorState(env.MONITOR_STATE)).lastSeenTweetId).toBeNull();
    const retry = vi.fn(async () => ({ verdict: "not_reset" as const, confidence: 0.9, rationale: "ok" }));
    await runMonitor(env, { ...deps, classify: retry });
    expect(retry).toHaveBeenCalledOnce();
    expect((await readMonitorState(env.MONITOR_STATE)).recentDecisions).toHaveLength(3);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

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

  it("persists a pending alert when dispatch fails and retries it on the next run", async () => {
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
    expect(state.lastSeenTweetId).toBe("2");
    expect(state.lastError).toContain("telegram down");
    expect(state.recentDecisions[0]).toMatchObject({
      tweetId: "2",
      verdict: "reset_confirmed",
      deliveryMode: "cached",
      alertEligibility: "eligible",
    });

    const retryDispatch = vi.fn(async () => ({ mode: "queued" as const, queuedCount: 4 }));
    await runMonitor(env, {
      fetchTweets: async () => [createTweet("1"), createTweet("2")],
      classify: async () => {
        throw new Error("pending decisions must not be classified again");
      },
      dispatch: retryDispatch,
    });

    const retriedState = await readMonitorState(env.MONITOR_STATE);
    expect(retryDispatch).toHaveBeenCalledTimes(1);
    expect(retriedState.recentDecisions[0]).toMatchObject({
      tweetId: "2",
      deliveryMode: "queued",
      queuedCount: 4,
    });
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

  it("dispatches a fresh confirmed post discovered below the watermark without regressing progress", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-30T00:02:00.000Z"));
    const env = createEnv();
    await writeMonitorState(env.MONITOR_STATE, {
      lastSeenTweetId: "2093801838504186008",
      lastSeenTweetUrl: "https://x.com/thsottiaux/status/2093801838504186008",
      lastCheckAt: new Date().toISOString(),
      lastError: null,
      recentDecisions: [],
    });
    const incidentTweet = {
      ...createTweet("2093801758665715784"),
      createdAt: "2026-08-29T20:43:34.000Z",
      fullText: "We are reseting usage for all paid users of Codex and ChatGPT Work.",
    };
    const dispatch = vi.fn(async () => ({ mode: "queued" as const, queuedCount: 4 }));

    await runMonitor(env, {
      fetchTweets: async () => [incidentTweet],
      classify: async () => ({ verdict: "reset_confirmed", confidence: 0.99, rationale: "Usage resets announced." }),
      dispatch,
    });

    const state = await readMonitorState(env.MONITOR_STATE);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(state.lastSeenTweetId).toBe("2093801838504186008");
    expect(state.recentDecisions.find((decision) => decision.tweetId === incidentTweet.id)).toMatchObject({
      deliveryMode: "queued",
      queuedCount: 4,
    });
  });

  it("dispatches a delayed fresh reset when a newer unrelated post is fetched at the same time", async () => {
    const env = { ...createEnv(), TARGET_USERNAMES: "thsottiaux,sama" };
    await writeMonitorState(env.MONITOR_STATE, {
      lastSeenTweetId: "100",
      lastSeenTweetUrl: "https://x.com/thsottiaux/status/100",
      lastCheckAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
      lastError: null,
      recentDecisions: [],
    });
    const delayedReset = {
      ...createTweet("101"),
      createdAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      fullText: "Codex limits have reset.",
    };
    const newerPost = {
      ...createTweet("102", "sama"),
      createdAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      fullText: "Unrelated update.",
    };
    const dispatch = vi.fn(async () => ({ mode: "queued" as const, queuedCount: 4 }));

    await runMonitor(env, {
      fetchTweets: async () => [delayedReset, newerPost],
      classify: async (_env, tweet) => tweet.id === delayedReset.id
        ? { verdict: "reset_confirmed", confidence: 0.99, rationale: "Usage reset." }
        : { verdict: "not_reset", confidence: 0.99, rationale: "Unrelated." },
      dispatch,
    });

    const state = await readMonitorState(env.MONITOR_STATE);
    expect(dispatch).toHaveBeenCalledWith(env, delayedReset, expect.objectContaining({ verdict: "reset_confirmed" }));
    expect(state.lastSeenTweetId).toBe("102");
  });

  it("does not dispatch an expired post discovered below the watermark", async () => {
    const env = createEnv();
    await writeMonitorState(env.MONITOR_STATE, {
      lastSeenTweetId: "200",
      lastSeenTweetUrl: "https://x.com/thsottiaux/status/200",
      lastCheckAt: new Date().toISOString(),
      lastError: null,
      recentDecisions: [],
    });
    const expiredReset = {
      ...createTweet("150"),
      createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
      fullText: "Codex limits have reset.",
    };
    const dispatch = vi.fn(async () => ({ mode: "queued" as const, queuedCount: 4 }));

    await runMonitor(env, {
      fetchTweets: async () => [expiredReset],
      classify: async () => ({ verdict: "reset_confirmed", confidence: 0.99, rationale: "Usage reset." }),
      dispatch,
    });

    const state = await readMonitorState(env.MONITOR_STATE);
    expect(dispatch).not.toHaveBeenCalled();
    expect(state.lastSeenTweetId).toBe("200");
    expect(state.recentDecisions.find((decision) => decision.tweetId === expiredReset.id)?.deliveryMode).toBe("cached");
  });
});
