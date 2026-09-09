import {
  compareTweetIds,
  fetchRecentTweets,
  getUnseenTweets,
  normalizeTweets,
} from "../src/tweets";

const rettiwtMockState = vi.hoisted(() => ({
  failure: null as string | null,
  failUsername: null as string | null,
  failedOperation: null as string | null,
}));

const httpAlternativeResponse = (input: RequestInfo | URL): Response => {
  const username = String(input).endsWith("/sama") ? "sama" : "thsottiaux";
  const id = username === "sama" ? "2098888888888888888" : "2099999999999999999";
  return new Response(
    `Markdown Content:\n* [@${username}](https://x.com/${username}) [now](https://x.com/${username}/status/${id}) HTTP alternative post\n\nLinks/Buttons:\n- [now](https://x.com/${username}/status/${id})`,
    { status: 200 },
  );
};

vi.mock("rettiwt-api", () => ({
  Rettiwt: class {
    tweet: { search: (filter: { fromUsers: string[] }) => Promise<{ list: unknown[] }> };
    user: {
      details: (username: string) => Promise<{ id: string }>;
      timeline: (userId: string) => Promise<{ list: unknown[] }>;
      replies: (userId: string) => Promise<{ list: unknown[] }>;
    };

    constructor(config?: { apiKey?: string }) {
      const requireSuccess = (username: string | undefined, operation: string): void => {
        const usernameMatches = !rettiwtMockState.failUsername || username === rettiwtMockState.failUsername;
        const operationMatches = !rettiwtMockState.failedOperation || operation === rettiwtMockState.failedOperation;

        if (rettiwtMockState.failure && usernameMatches && operationMatches) {
          throw new Error(rettiwtMockState.failure);
        }

        if (!config?.apiKey) {
          throw new Error("Guest Rettiwt access used");
        }
      };

      this.tweet = {
        search: async (filter) => {
          requireSuccess(filter.fromUsers[0], "search");
          return { list: [] };
        },
      };
      this.user = {
        details: async (username) => {
          requireSuccess(username, "details");
          return { id: username };
        },
        timeline: async (userId) => {
          requireSuccess(userId, "timeline");
          const id = userId === "sama" ? "2093060670472241368" : "2093914342551101782";
          return {
            list: [
              {
                id,
                fullText: `Current post from ${userId}`,
                createdAt: new Date().toISOString(),
                tweetBy: { userName: userId },
              },
            ],
          };
        },
        replies: async (userId: string) => {
          requireSuccess(userId, "replies");
          return { list: [] };
        },
      };
    }
  },
}));

describe("tweets", () => {
  beforeEach(() => {
    rettiwtMockState.failure = null;
    rettiwtMockState.failUsername = null;
    rettiwtMockState.failedOperation = null;
  });

  it("compares snowflake IDs numerically", () => {
    expect(compareTweetIds("10000000000000000000", "9999999999999999999")).toBe(1);
    expect(compareTweetIds("2", "10")).toBe(-1);
    expect(compareTweetIds("10", "10")).toBe(0);
  });

  it("normalizes, filters, dedupes, and keeps retweets", () => {
    const tweets = normalizeTweets(
      {
        list: [
          {
            id: "3",
            fullText: "new post",
            createdAt: "2026-07-07T12:00:00.000Z",
            tweetBy: { userName: "thsottiaux" },
          },
          {
            id: "3",
            fullText: "duplicate",
            createdAt: "2026-07-07T12:00:00.000Z",
            tweetBy: { userName: "thsottiaux" },
          },
          {
            id: "4",
            fullText: "retweet",
            createdAt: "2026-07-07T12:00:00.000Z",
            tweetBy: { userName: "thsottiaux" },
            retweetedTweet: { id: "1", fullText: "original reset-ish post" },
          },
          {
            id: "5",
            fullText: "wrong author",
            createdAt: "2026-07-07T12:00:00.000Z",
            tweetBy: { userName: "someone_else" },
          },
        ],
      },
      "thsottiaux",
      new Date("2026-07-07T00:00:00.000Z"),
    );

    expect(tweets).toHaveLength(2);
    expect(tweets[0]?.id).toBe("3");
    expect(tweets[0]?.url).toBe("https://x.com/thsottiaux/status/3");
    expect(tweets[1]?.id).toBe("4");
    expect(tweets[1]?.isRetweet).toBe(true);
    expect(tweets[1]?.fullText).toContain("Reposted text:");
  });

  it("returns unseen tweets in ascending order", () => {
    const tweets = [
      {
        id: "12",
        url: "https://x.com/thsottiaux/status/12",
        createdAt: "2026-07-07T12:00:00.000Z",
        fullText: "second",
        authorUsername: "thsottiaux",
        isRetweet: false,
        isReply: false,
      },
      {
        id: "11",
        url: "https://x.com/thsottiaux/status/11",
        createdAt: "2026-07-07T11:00:00.000Z",
        fullText: "first",
        authorUsername: "thsottiaux",
        isRetweet: false,
        isReply: false,
      },
    ];

    expect(getUnseenTweets(tweets, "10").map((tweet) => tweet.id)).toEqual(["11", "12"]);
  });

  it("requires Rettiwt credentials before fetching tweets", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => httpAlternativeResponse(input)));

    try {
      await expect(fetchRecentTweets({
        MONITOR_STATE: {} as KVNamespace,
        TARGET_USERNAMES: "thsottiaux",
      })).rejects.toThrow("RETTIWT_API_KEY is required");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("uses authenticated Rettiwt as the only tweet source", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => httpAlternativeResponse(input));
    vi.stubGlobal("fetch", fetchMock);

    try {
      const tweets = await fetchRecentTweets({
        MONITOR_STATE: {} as KVNamespace,
        RETTIWT_API_KEY: "configured-key",
        TARGET_USERNAMES: "thsottiaux,sama",
      });

      expect(tweets.map((tweet) => tweet.authorUsername).sort()).toEqual(["sama", "thsottiaux"]);
      expect(tweets.map((tweet) => tweet.fullText).sort()).toEqual([
        "Current post from sama",
        "Current post from thsottiaux",
      ]);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("reports the authenticated Rettiwt failure details", async () => {
    rettiwtMockState.failure = "Configured Rettiwt key rejected";

    await expect(fetchRecentTweets({
      MONITOR_STATE: {} as KVNamespace,
      RETTIWT_API_KEY: "stale-key",
      TARGET_USERNAMES: "thsottiaux",
    })).rejects.toThrow(/@thsottiaux.*Configured Rettiwt key rejected/);
  });

  it("fails the poll when Rettiwt cannot fetch one target", async () => {
    rettiwtMockState.failure = "Target fetch rejected";
    rettiwtMockState.failUsername = "sama";

    await expect(fetchRecentTweets({
      MONITOR_STATE: {} as KVNamespace,
      RETTIWT_API_KEY: "configured-key",
      TARGET_USERNAMES: "thsottiaux,sama",
    })).rejects.toThrow(/@sama.*Target fetch rejected/);
  });

  it("fails the poll when one Rettiwt endpoint fails", async () => {
    rettiwtMockState.failure = "Timeline rejected";
    rettiwtMockState.failedOperation = "timeline";

    await expect(fetchRecentTweets({
      MONITOR_STATE: {} as KVNamespace,
      RETTIWT_API_KEY: "configured-key",
      TARGET_USERNAMES: "thsottiaux",
    })).rejects.toThrow(/@thsottiaux.*timeline: Timeline rejected/);
  });
});
