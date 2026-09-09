import { getEnvString, getErrorMessage, getNumberEnv, getTargetUsernames } from "./env";
import type { Rettiwt as RettiwtClient } from "rettiwt-api";
import type { Env, Tweet } from "./types";

const DEFAULT_SEARCH_BATCH_SIZE = 20;
const DEFAULT_LOOKBACK_HOURS = 24;
const RETTIWT_REQUEST_TIMEOUT_MS = 15_000;

type AnyRecord = Record<string, unknown>;

let rettiwtModulePromise: Promise<typeof import("rettiwt-api")> | null = null;

const asRecord = (value: unknown): AnyRecord | undefined =>
  value && typeof value === "object" ? value as AnyRecord : undefined;

export const compareTweetIds = (left: string, right: string): number => {
  try {
    const leftId = BigInt(left);
    const rightId = BigInt(right);

    if (leftId === rightId) {
      return 0;
    }

    return leftId > rightId ? 1 : -1;
  } catch (_error) {
    if (left === right) {
      return 0;
    }

    return left > right ? 1 : -1;
  }
};

export const sortTweetsAscending = (tweets: Tweet[]): Tweet[] =>
  [...tweets].sort((left, right) => compareTweetIds(left.id, right.id));

const getString = (...values: unknown[]): string => {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }

    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }

  return "";
};

const getNestedString = (record: AnyRecord | undefined, path: string[]): string => {
  let current: unknown = record;

  for (const segment of path) {
    const currentRecord = asRecord(current);

    if (!currentRecord) {
      return "";
    }

    current = currentRecord[segment];
  }

  return getString(current);
};

const normalizeUsername = (value: string): string => value.replace(/^@+/, "").toLowerCase();

const normalizeBatch = (result: unknown): unknown[] => {
  if (Array.isArray(result)) {
    return result;
  }

  const record = asRecord(result);

  for (const key of ["list", "data", "tweets"]) {
    const value = record?.[key];

    if (Array.isArray(value)) {
      return value;
    }
  }

  return [];
};

const normalizeDateString = (value: string): string => {
  if (!value) {
    return "";
  }

  const timestamp = new Date(value).valueOf();
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : value;
};

export const normalizeTweet = (raw: unknown, targetUsername: string): Tweet | null => {
  const record = asRecord(raw);

  if (!record) {
    return null;
  }

  const id = getString(record.id, record.idStr, record.id_str, record.rest_id);
  const retweeted = asRecord(record.retweetedTweet) || asRecord(record.retweeted_status);
  const authorUsername = normalizeUsername(
    getString(
      record.authorUsername,
      record.userName,
      record.username,
      getNestedString(record, ["tweetBy", "userName"]),
      getNestedString(record, ["author", "userName"]),
      getNestedString(record, ["author", "screen_name"]),
      getNestedString(record, ["user", "screen_name"]),
      getNestedString(record, ["user", "userName"]),
    ),
  );
  const rawFullText = getString(
    record.fullText,
    record.text,
    record.tweetText,
    record.content,
    getNestedString(record, ["legacy", "full_text"]),
  );
  const retweetedText = getString(
    retweeted?.fullText,
    retweeted?.text,
    retweeted?.tweetText,
    retweeted?.content,
    getNestedString(retweeted, ["legacy", "full_text"]),
  );
  const fullText = retweetedText && !rawFullText.includes(retweetedText)
    ? [rawFullText || "Repost", "", "Reposted text:", retweetedText].join("\n")
    : rawFullText;
  const createdAt = normalizeDateString(
    getString(record.createdAt, record.created_at, getNestedString(record, ["legacy", "created_at"])),
  );

  if (!id || !authorUsername || !fullText) {
    return null;
  }

  const target = normalizeUsername(targetUsername);
  const quoted = asRecord(record.quoted) || asRecord(record.quotedTweet) || asRecord(record.quoted_status);
  const url = getString(record.url, record.tweetUrl) || `https://x.com/${target}/status/${id}`;

  return {
    id,
    url,
    createdAt,
    fullText,
    authorUsername,
    isRetweet: Boolean(record.retweetedTweet || record.retweeted_status || record.isRetweet),
    isReply: Boolean(record.replyTo || record.inReplyToStatusId || record.in_reply_to_status_id || record.isReply),
    quotedText: getString(quoted?.fullText, quoted?.text, quoted?.tweetText) || null,
    quotedUrl: getString(quoted?.url, quoted?.tweetUrl) || null,
    quotedCreatedAt: normalizeDateString(getString(quoted?.createdAt, quoted?.created_at)) || null,
  };
};

export const dedupeTweetsById = (tweets: Tweet[]): Tweet[] =>
  Array.from(
    tweets.reduce((entries, tweet) => {
      if (!entries.has(tweet.id)) {
        entries.set(tweet.id, tweet);
      }

      return entries;
    }, new Map<string, Tweet>()).values(),
  );

export const isAuthoredTimelineTweet = (tweet: Tweet, targetUsername: string): boolean =>
  Boolean(tweet.id) && tweet.authorUsername === normalizeUsername(targetUsername);

export const isAuthoredByTargetUsername = (tweet: Tweet, targetUsernames: string[]): boolean =>
  Boolean(tweet.id) && new Set(targetUsernames.map(normalizeUsername)).has(tweet.authorUsername);

const filterTweetsByStartDate = (tweets: Tweet[], startDate: Date): Tweet[] => {
  const minimumTimestamp = startDate.valueOf();

  if (!Number.isFinite(minimumTimestamp)) {
    return dedupeTweetsById(tweets);
  }

  return dedupeTweetsById(tweets).filter((tweet) => {
    const createdAt = new Date(tweet.createdAt).valueOf();
    return Number.isFinite(createdAt) && createdAt >= minimumTimestamp;
  });
};

export const normalizeTweets = (result: unknown, targetUsername: string, startDate: Date): Tweet[] =>
  filterTweetsByStartDate(
    normalizeBatch(result)
      .map((entry) => normalizeTweet(entry, targetUsername))
      .filter((tweet): tweet is Tweet => Boolean(tweet))
      .filter((tweet) => isAuthoredTimelineTweet(tweet, targetUsername)),
    startDate,
  );

export const getNewestTweet = (tweets: Tweet[]): Tweet | null =>
  tweets.reduce<Tweet | null>((newest, tweet) => {
    if (!newest) {
      return tweet;
    }

    return compareTweetIds(tweet.id, newest.id) > 0 ? tweet : newest;
  }, null);

export const getUnseenTweets = (tweets: Tweet[], lastSeenTweetId: string | null): Tweet[] =>
  sortTweetsAscending(
    dedupeTweetsById(tweets).filter(
      (tweet) => !lastSeenTweetId || compareTweetIds(tweet.id, lastSeenTweetId) > 0,
    ),
  );

const getRecentTweetSearchStartDate = (env: Env): Date => {
  const lookbackHours = getNumberEnv(env.POLL_LOOKBACK_HOURS, DEFAULT_LOOKBACK_HOURS);
  return new Date(Date.now() - lookbackHours * 60 * 60 * 1000);
};

const getRettiwt = async (): Promise<typeof import("rettiwt-api")> => {
  if (!rettiwtModulePromise) {
    rettiwtModulePromise = import("rettiwt-api");
  }

  return rettiwtModulePromise;
};

const createRettiwtClient = async (env: Env): Promise<RettiwtClient> => {
  const apiKey = getEnvString(env.RETTIWT_API_KEY);

  if (!apiKey) {
    throw new Error("RETTIWT_API_KEY is required for tweet monitoring");
  }

  const { Rettiwt } = await getRettiwt();
  return new Rettiwt({ apiKey, timeout: RETTIWT_REQUEST_TIMEOUT_MS });
};

const fetchFromRettiwtForUsername = async (
  rettiwt: RettiwtClient,
  targetUsername: string,
  startDate: Date,
): Promise<Tweet[]> => {
  const results: unknown[] = [];
  const errors: string[] = [];

  try {
    results.push(await rettiwt.tweet.search(
      { fromUsers: [targetUsername], startDate },
      DEFAULT_SEARCH_BATCH_SIZE,
    ));
  } catch (error) {
    errors.push(`search: ${getErrorMessage(error)}`);
  }

  try {
    const user = asRecord(await rettiwt.user.details(targetUsername));
    const userId = getString(user?.id, user?.rest_id);

    if (!userId) {
      throw new Error(`Unable to resolve @${targetUsername} user ID`);
    }

    const timelineResponses = await Promise.allSettled([
      rettiwt.user.timeline(userId, DEFAULT_SEARCH_BATCH_SIZE),
      rettiwt.user.replies(userId, DEFAULT_SEARCH_BATCH_SIZE),
    ]);

    for (const [index, response] of timelineResponses.entries()) {
      const operation = index === 0 ? "timeline" : "replies";

      if (response.status === "fulfilled") {
        results.push(response.value);
      } else {
        errors.push(`${operation}: ${getErrorMessage(response.reason)}`);
      }
    }
  } catch (error) {
    errors.push(`user details: ${getErrorMessage(error)}`);
  }

  const tweets = normalizeTweets(results.flatMap(normalizeBatch), targetUsername, startDate);

  if (errors.length > 0) {
    throw new Error(`Rettiwt fetch failed for @${targetUsername}: ${errors.join("; ")}`);
  }

  return tweets;
};

const fetchFromRettiwt = async (env: Env, startDate: Date): Promise<Tweet[]> => {
  const rettiwt = await createRettiwtClient(env);
  const targetUsernames = getTargetUsernames(env);
  const responses = await Promise.allSettled(
    targetUsernames.map((targetUsername) => fetchFromRettiwtForUsername(rettiwt, targetUsername, startDate)),
  );
  const failures = responses
    .map((response) => response.status === "rejected" ? getErrorMessage(response.reason) : null)
    .filter((failure): failure is string => Boolean(failure));

  if (failures.length > 0) {
    throw new Error(`Authenticated Rettiwt tweet fetch failed: ${failures.join("; ")}`);
  }

  return dedupeTweetsById(
    responses.flatMap((response) => response.status === "fulfilled" ? response.value : []),
  );
};

export const getTweetSourceDiagnostics = async (env: Env): Promise<Record<string, unknown>> => {
  const targetUsernames = getTargetUsernames(env);
  const startDate = getRecentTweetSearchStartDate(env);
  const apiKeyConfigured = Boolean(getEnvString(env.RETTIWT_API_KEY));

  if (!apiKeyConfigured) {
    return {
      source: "rettiwt",
      authenticated: false,
      targetUsernames,
      startDate: startDate.toISOString(),
      error: "RETTIWT_API_KEY is required for tweet monitoring",
    };
  }

  const rettiwt = await createRettiwtClient(env);
  const results = await Promise.all(targetUsernames.map(async (targetUsername) => {
    try {
      const tweets = await fetchFromRettiwtForUsername(rettiwt, targetUsername, startDate);
      return {
        username: targetUsername,
        ok: true,
        parsedCount: tweets.length,
        firstParsedTweet: tweets[0]
          ? {
              id: tweets[0].id,
              createdAt: tweets[0].createdAt,
              url: tweets[0].url,
              text: tweets[0].fullText.slice(0, 160),
            }
          : null,
      };
    } catch (error) {
      return {
        username: targetUsername,
        ok: false,
        error: getErrorMessage(error),
      };
    }
  }));

  return {
    source: "rettiwt",
    authenticated: true,
    targetUsernames,
    startDate: startDate.toISOString(),
    results,
  };
};

export const fetchRecentTweets = async (env: Env): Promise<Tweet[]> => {
  const recentTweets = await fetchFromRettiwt(env, getRecentTweetSearchStartDate(env));

  if (recentTweets.length > 0) {
    return recentTweets;
  }

  return fetchFromRettiwt(env, new Date(0));
};
