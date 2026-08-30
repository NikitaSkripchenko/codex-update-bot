import {
  compareTweetIds,
  fetchRecentTweets,
  getUnseenTweets,
  normalizeTweets,
  parseJinaProfileTweets,
  parseNitterRssTweets,
} from "../src/tweets";

const rettiwtMockState = vi.hoisted(() => ({ authenticatedSearchSucceeds: false }));

vi.mock("rettiwt-api", () => ({
  Rettiwt: class {
    tweet: { search: () => Promise<unknown> };
    user: {
      details: () => Promise<{ id: string }>;
      timeline: () => Promise<{ list: unknown[] }>;
      replies: () => Promise<never>;
    };

    constructor(config?: { apiKey?: string }) {
      const authenticated = Boolean(config?.apiKey);
      this.tweet = {
        search: async () => authenticated && rettiwtMockState.authenticatedSearchSucceeds
          ? { list: [] }
          : Promise.reject(new Error(authenticated ? "Configured Rettiwt key rejected" : "Guest search unavailable")),
      };
      this.user = {
        details: async () => authenticated
          ? Promise.reject(new Error("Configured Rettiwt key rejected"))
          : { id: "123" },
        timeline: async () => authenticated
          ? Promise.reject(new Error("Configured Rettiwt key rejected"))
          : {
              list: [
                {
                  id: "2091688655828246890",
                  fullText: "Reset has been propagated to accounts.",
                  createdAt: "2026-08-24T00:46:51.000Z",
                  tweetBy: { userName: "thsottiaux" },
                },
              ],
            },
        replies: async () => Promise.reject(new Error(authenticated ? "Configured Rettiwt key rejected" : "Guest replies unavailable")),
      };
    }
  },
}));

describe("tweets", () => {
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

  it("parses current posts from Nitter RSS", () => {
    const tweets = parseNitterRssTweets(
      `<?xml version="1.0"?><rss><channel><item><title>Prepare your sunglasses. Sol is coming. &#128526;</title><description><![CDATA[<p>Prepare your sunglasses.</p><hr/><blockquote><p>Quoted context</p></blockquote>]]></description><pubDate>Wed, 08 Jul 2026 04:02:35 GMT</pubDate><guid isPermaLink="false">2074705681920520526</guid><link>https://nitter.net/thsottiaux/status/2074705681920520526#m</link></item></channel></rss>`,
      "thsottiaux",
    );

    expect(tweets).toHaveLength(1);
    expect(tweets[0]?.id).toBe("2074705681920520526");
    expect(tweets[0]?.url).toBe("https://x.com/thsottiaux/status/2074705681920520526");
    expect(tweets[0]?.fullText).toContain("Prepare your sunglasses");
    expect(tweets[0]?.quotedText).toContain("Quoted context");
  });

  it("ignores RSS items that are not numeric tweet statuses", () => {
    const tweets = parseNitterRssTweets(
      `<?xml version="1.0"?><rss><channel><item><title>RSS reader not yet whitelisted!</title><description>Please send an email.</description><pubDate>Fri, 01 Jan 1971 00:00:00 GMT</pubDate><guid isPermaLink="false">https://rss.xcancel.com/thsottiaux/rss</guid><link>https://rss.xcancel.com/thsottiaux/rss</link></item></channel></rss>`,
      "thsottiaux",
    );

    expect(tweets).toEqual([]);
  });

  it("parses authored profile posts and stable timestamps from Jina Reader markdown", () => {
    const tweets = parseJinaProfileTweets(
      `Title: Tibo (@thsottiaux) on X

Markdown Content:
* [![Image: @thsottiaux](https://pbs.twimg.com/profile.jpg)](https://x.com/thsottiaux) [Tibo](https://x.com/thsottiaux) [@thsottiaux](https://x.com/thsottiaux) [3h](https://x.com/thsottiaux/status/2093914342551101782) Team is cooking like never before 559 88 4.2K 191K
* [![Image: @thsottiaux](https://pbs.twimg.com/profile.jpg)](https://x.com/thsottiaux) [Tibo](https://x.com/thsottiaux) [@thsottiaux](https://x.com/thsottiaux) [11h](https://x.com/thsottiaux/status/2093801758665715784) We are reseting usage for all paid users of Codex and ChatGPT Work. Show more 1.3K 885 17K 1.5M

Links/Buttons:
- [3h](https://x.com/thsottiaux/status/2093914342551101782)
- [11h](https://x.com/thsottiaux/status/2093801758665715784)
- [quoted](https://x.com/other/status/2093532254006063557)`,
      "thsottiaux",
    );

    expect(tweets.map((tweet) => tweet.id)).toEqual(["2093914342551101782", "2093801758665715784"]);
    expect(tweets[0]).toMatchObject({
      authorUsername: "thsottiaux",
      createdAt: "2026-08-30T04:10:56.968Z",
      fullText: "Team is cooking like never before",
    });
    expect(tweets[1]?.fullText).toContain("reseting usage for all paid users");
    expect(tweets[1]?.fullText).not.toContain("Show more");
  });

  it("uses Jina Reader when every Nitter instance is unavailable", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);

      if (url.startsWith("https://r.jina.ai/https://x.com/")) {
        const username = url.endsWith("/sama") ? "sama" : "thsottiaux";
        const id = username === "sama" ? "2093060670472241368" : "2093914342551101782";
        return new Response(
          `Markdown Content:\n* [![Image: @${username}](https://pbs.twimg.com/profile.jpg)](https://x.com/${username}) current post from ${username}\n\nLinks/Buttons:\n- [now](https://x.com/${username}/status/${id})`,
          { status: 200, headers: { "content-type": "text/plain" } },
        );
      }

      return new Response("unavailable", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const tweets = await fetchRecentTweets({
        MONITOR_STATE: {} as KVNamespace,
        TARGET_USERNAMES: "thsottiaux,sama",
      });

      expect(tweets.map((tweet) => tweet.authorUsername).sort()).toEqual(["sama", "thsottiaux"]);
      expect(fetchMock).toHaveBeenCalledWith(
        "https://r.jina.ai/https://x.com/thsottiaux",
        expect.objectContaining({
          headers: expect.objectContaining({ "x-with-links-summary": "all" }),
          signal: expect.any(AbortSignal),
        }),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("retries a preferred Nitter host after a transient response", async () => {
    const calls: Array<{ url: string; signal: AbortSignal | null | undefined }> = [];
    const createdAt = new Date().toUTCString();

    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, signal: init?.signal });
      const preferredAttempts = calls.filter((call) => call.url.startsWith("https://preferred.test/")).length;

      if (url.startsWith("https://preferred.test/") && preferredAttempts === 1) {
        return new Response("rate limited", { status: 429, headers: { "retry-after": "0" } });
      }

      return new Response(
        `<?xml version="1.0"?><rss><channel><item><title>Reset landed.</title><description>Reset landed.</description><pubDate>${createdAt}</pubDate><guid isPermaLink="false">2091688655828246890</guid><link>${url.replace(/\/rss$/, "/status/2091688655828246890#m")}</link></item></channel></rss>`,
        { status: 200, headers: { "content-type": "application/rss+xml" } },
      );
    }));

    try {
      const tweets = await fetchRecentTweets({
        MONITOR_STATE: {} as KVNamespace,
        NITTER_BASE_URL: "https://preferred.test",
        TARGET_USERNAMES: "thsottiaux",
      });

      expect(tweets).toHaveLength(1);
      expect(calls.filter((call) => call.url.startsWith("https://preferred.test/"))).toHaveLength(2);
      expect(calls[0]?.signal).toBeInstanceOf(AbortSignal);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("falls back to Rettiwt guest timeline when the configured key fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("unavailable", { status: 404 })));

    try {
      const tweets = await fetchRecentTweets({
        MONITOR_STATE: {} as KVNamespace,
        RETTIWT_API_KEY: "stale-key",
        TARGET_USERNAMES: "thsottiaux",
      });

      expect(tweets).toHaveLength(1);
      expect(tweets[0]).toMatchObject({
        authorUsername: "thsottiaux",
        id: "2091688655828246890",
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("uses the guest timeline after a partial authenticated Rettiwt failure", async () => {
    rettiwtMockState.authenticatedSearchSucceeds = true;
    vi.stubGlobal("fetch", vi.fn(async () => new Response("unavailable", { status: 404 })));

    try {
      const tweets = await fetchRecentTweets({
        MONITOR_STATE: {} as KVNamespace,
        RETTIWT_API_KEY: "stale-key",
        TARGET_USERNAMES: "thsottiaux",
      });

      expect(tweets).toHaveLength(1);
      expect(tweets[0]?.id).toBe("2091688655828246890");
    } finally {
      rettiwtMockState.authenticatedSearchSucceeds = false;
      vi.unstubAllGlobals();
    }
  });
});
