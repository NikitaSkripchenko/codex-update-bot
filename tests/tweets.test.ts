import { compareTweetIds, getUnseenTweets, normalizeTweets, parseNitterRssTweets } from "../src/tweets";

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
});
