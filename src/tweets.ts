import { getEnvString, getErrorMessage, getNumberEnv, getTargetUsernames, splitCsv } from "./env";
import type { Env, Tweet } from "./types";

const DEFAULT_SEARCH_BATCH_SIZE = 20;
const DEFAULT_LOOKBACK_HOURS = 24;
const DEFAULT_NITTER_BASE_URL = "https://nitter.net";
const DEFAULT_JINA_READER_BASE_URL = "https://r.jina.ai/https://x.com";
const JINA_REQUEST_TIMEOUT_MS = 20_000;
const TWITTER_SNOWFLAKE_EPOCH_MS = 1_288_834_974_657n;
const NITTER_REQUEST_TIMEOUT_MS = 5_000;
const NITTER_RETRY_DELAY_MS = 500;
const MAX_NITTER_RETRY_AFTER_MS = 5_000;
const FALLBACK_NITTER_BASE_URLS = [
  DEFAULT_NITTER_BASE_URL,
  "https://xcancel.com",
  "https://nitter.privacyredirect.com",
  "https://lightbrd.com",
  "https://nitter.space",
  "https://nitter.tiekoetter.com",
  "https://nitter.catsarch.com",
  "https://nitter.kareem.one",
  "https://nt.vern.cc",
];

type AnyRecord = Record<string, any>;

let rettiwtModulePromise: Promise<{ Rettiwt: new (config?: { apiKey?: string; timeout?: number }) => any }> | null = null;

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
    if (!current || typeof current !== "object") {
      return "";
    }

    current = (current as AnyRecord)[segment];
  }

  return getString(current);
};

const normalizeUsername = (value: string): string => value.replace(/^@+/, "").toLowerCase();

const normalizeBatch = (result: unknown): unknown[] => {
  if (Array.isArray(result)) {
    return result;
  }

  const record = result as AnyRecord | null;

  if (Array.isArray(record?.list)) {
    return record.list;
  }

  if (Array.isArray(record?.data)) {
    return record.data;
  }

  if (Array.isArray(record?.tweets)) {
    return record.tweets;
  }

  return [];
};

const normalizeBaseUrl = (value: string): string => value.trim().replace(/\/+$/, "");

const getNitterBaseUrls = (env: Env): string[] => {
  const configuredUrls = splitCsv(env.NITTER_BASE_URL).map(normalizeBaseUrl).filter(Boolean);
  const urls = configuredUrls.length > 0 ? [...configuredUrls, ...FALLBACK_NITTER_BASE_URLS] : FALLBACK_NITTER_BASE_URLS;

  return Array.from(new Set(urls.map(normalizeBaseUrl).filter(Boolean)));
};

const normalizeDateString = (value: string): string => {
  if (!value) {
    return "";
  }

  const timestamp = new Date(value).valueOf();
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : value;
};

const decodeHtmlEntities = (value: string): string =>
  value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");

const stripHtml = (value: string): string =>
  normalizeWhitespace(
    decodeHtmlEntities(
      value
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/p>/gi, "\n")
        .replace(/<[^>]+>/g, " "),
    ),
  );

const normalizeWhitespace = (value: string): string => value.replace(/\s+/g, " ").trim();

const getTagValue = (value: string, tagName: string): string => {
  const match = value.match(new RegExp(`<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tagName}>`, "i"));
  return match?.[1] ? decodeHtmlEntities(match[1]).trim() : "";
};

export const parseNitterRssTweets = (rss: string, targetUsername: string): Tweet[] => {
  const target = normalizeUsername(targetUsername);
  const items = Array.from(rss.matchAll(/<item>([\s\S]*?)<\/item>/gi));

  return items
    .map(([, item]): Tweet | null => {
      const title = stripHtml(getTagValue(item, "title"));
      const description = stripHtml(getTagValue(item, "description"));
      const guid = getTagValue(item, "guid");
      const link = getTagValue(item, "link");
      const createdAt = normalizeDateString(getTagValue(item, "pubDate"));
      const id = link.match(/status\/(\d+)/)?.[1] || (/^\d+$/.test(guid) ? guid : "");
      const nitterUrl = link || (id ? `${DEFAULT_NITTER_BASE_URL}/${target}/status/${id}` : "");
      const url = nitterUrl.replace(/^https?:\/\/[^/]+\//, "https://x.com/").replace(/#m$/, "");
      const isReply = title.startsWith("R to @") || description.startsWith("R to @");
      const isRetweet = description.includes("— https://nitter.net/") || /\bRT by @/i.test(description);
      const quotedText = description && description !== title ? description : null;

      if (!id || !title || !createdAt) {
        return null;
      }

      return {
        authorUsername: target,
        createdAt,
        fullText: title,
        id,
        isReply,
        isRetweet,
        quotedText,
        quotedUrl: null,
        quotedCreatedAt: null,
        url,
      };
    })
    .filter((tweet): tweet is Tweet => tweet !== null);
};

const getTweetCreatedAtFromId = (id: string): string => {
  try {
    const timestamp = Number((BigInt(id) >> 22n) + TWITTER_SNOWFLAKE_EPOCH_MS);
    return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : "";
  } catch (_error) {
    return "";
  }
};

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const cleanJinaPostText = (value: string): string => {
  const withoutMedia = value
    .replace(/\[!\[[^\]]*\]\([^)]+\)\]\([^)]+\)/g, " ")
    .replace(/!\[[^\]]*\]\([^)]+\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\bShow more\b/gi, " ")
    .replace(/(?:\s+\d+(?:[.,]\d+)?[KMB]?){2,}\s*$/i, " ");

  return normalizeWhitespace(withoutMedia);
};

export const parseJinaProfileTweets = (markdown: string, targetUsername: string): Tweet[] => {
  const target = normalizeUsername(targetUsername);
  const escapedTarget = escapeRegExp(target);
  const statusPattern = new RegExp(`https?://(?:x|twitter)\\.com/${escapedTarget}/status/(\\d+)`, "gi");
  const tweetIds = Array.from(markdown.matchAll(statusPattern), (match) => match[1]).filter(
    (id, index, ids): id is string => Boolean(id) && ids.indexOf(id) === index,
  );
  const body = (markdown.split(/\nLinks\/Buttons:/i)[0] || markdown).split(/\n## Log in or sign up/i)[0] || markdown;
  const bullets = Array.from(body.matchAll(/(?:^|\n)\*\s+([\s\S]*?)(?=\n\*\s+|$)/g), (match) => match[1] || "")
    .filter((entry) => new RegExp(`https?://(?:x|twitter)\\.com/${escapedTarget}(?:[)/])`, "i").test(entry));
  const assignedIds = new Set<string>();

  return bullets.map((bullet) => {
    const inlineId = new RegExp(
      `https?://(?:x|twitter)\\.com/${escapedTarget}/status/(\\d+)`,
      "i",
    ).exec(bullet)?.[1];
    const id = inlineId || tweetIds.find((candidate) => !assignedIds.has(candidate)) || "";
    assignedIds.add(id);
    const inlineStatus = new RegExp(
      `\\[[^\\]]*\\]\\(https?://(?:x|twitter)\\.com/${escapedTarget}/status/${id}[^)]*\\)\\s*([\\s\\S]*)`,
      "i",
    ).exec(bullet);
    const fullText = cleanJinaPostText(inlineStatus?.[1] || bullet);

    return {
      id,
      url: `https://x.com/${target}/status/${id}`,
      createdAt: getTweetCreatedAtFromId(id),
      fullText,
      authorUsername: target,
      isRetweet: false,
      isReply: false,
      quotedText: null,
      quotedUrl: null,
      quotedCreatedAt: null,
    };
  }).filter((tweet) => Boolean(tweet.id && tweet.createdAt && tweet.fullText));
};

const fetchJinaProfileForUsername = async (env: Env, targetUsername: string): Promise<Tweet[]> => {
  const baseUrl = normalizeBaseUrl(getEnvString(env.JINA_READER_BASE_URL, DEFAULT_JINA_READER_BASE_URL));
  const response = await fetch(`${baseUrl}/${encodeURIComponent(targetUsername)}`, {
    signal: AbortSignal.timeout(JINA_REQUEST_TIMEOUT_MS),
    headers: {
      accept: "text/plain; charset=utf-8",
      "x-cache-tolerance": "300",
      "x-timeout": "15",
      "x-with-links-summary": "all",
    },
  });

  if (!response.ok) {
    throw new Error(`Jina Reader returned ${response.status} for @${targetUsername}`);
  }

  const tweets = parseJinaProfileTweets(await response.text(), targetUsername);

  if (tweets.length === 0) {
    throw new Error(`Jina Reader returned no parseable posts for @${targetUsername}`);
  }

  return tweets;
};

const fetchFromJinaProfiles = async (env: Env): Promise<Tweet[]> => {
  const tweets = await Promise.all(
    getTargetUsernames(env).map((targetUsername) => fetchJinaProfileForUsername(env, targetUsername)),
  );

  return dedupeTweetsById(tweets.flat());
};

const getNitterRetryDelayMs = (response: Response): number => {
  const retryAfterHeader = response.headers.get("retry-after");
  const retryAfter = retryAfterHeader === null ? Number.NaN : Number(retryAfterHeader);
  return Number.isFinite(retryAfter) && retryAfter >= 0
    ? Math.min(retryAfter * 1_000, MAX_NITTER_RETRY_AFTER_MS)
    : NITTER_RETRY_DELAY_MS;
};

const sleep = async (delayMs: number): Promise<void> => {
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
};

const fetchNitterRssText = async (
  baseUrl: string,
  targetUsername: string,
  retryTransient = false,
): Promise<Response> => {
  const attempts = retryTransient ? 2 : 1;
  let lastResponse: Response | null = null;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const response = await fetch(`${baseUrl}/${targetUsername}/rss`, {
      signal: AbortSignal.timeout(NITTER_REQUEST_TIMEOUT_MS),
      headers: {
        accept: "application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8",
        "user-agent": "codex-limit-telegram-bot/1.0 (+https://workers.cloudflare.com)",
      },
    });
    lastResponse = response;

    if (![429, 500, 502, 503, 504].includes(response.status) || attempt === attempts - 1) {
      return response;
    }

    await sleep(getNitterRetryDelayMs(response));
  }

  if (!lastResponse) {
    throw new Error(`Nitter did not return a response for @${targetUsername}`);
  }

  return lastResponse;
};

export const getTweetSourceDiagnostics = async (env: Env): Promise<Record<string, unknown>> => {
  const targetUsernames = getTargetUsernames(env);
  const startDate = getRecentTweetSearchStartDate(env);
  const baseUrls = getNitterBaseUrls(env);
  const configuredBaseUrls = new Set(splitCsv(env.NITTER_BASE_URL).map(normalizeBaseUrl));
  const attempts: Record<string, unknown>[] = [];
  const jina: Record<string, unknown>[] = [];

  for (const targetUsername of targetUsernames) {
    try {
      const tweets = await fetchJinaProfileForUsername(env, targetUsername);
      jina.push({
        username: targetUsername,
        ok: true,
        parsedCount: tweets.length,
        firstParsedTweet: tweets[0]
          ? { id: tweets[0].id, createdAt: tweets[0].createdAt, url: tweets[0].url, text: tweets[0].fullText.slice(0, 160) }
          : null,
      });
    } catch (error) {
      jina.push({
        username: targetUsername,
        ok: false,
        error: getErrorMessage(error),
      });
    }
  }

  for (const targetUsername of targetUsernames) {
    for (const baseUrl of baseUrls) {
      const nitterUrl = `${baseUrl}/${targetUsername}/rss`;

      try {
        const response = await fetchNitterRssText(baseUrl, targetUsername, configuredBaseUrls.has(baseUrl));
        const body = await response.text();
        const parsedTweets = parseNitterRssTweets(body, targetUsername);
        const filteredTweets = filterTweetsByStartDate(parsedTweets, startDate);
        attempts.push({
          username: targetUsername,
          url: nitterUrl,
          ok: response.ok,
          status: response.status,
          statusText: response.statusText,
          contentType: response.headers.get("content-type"),
          bodyPreview: body.slice(0, 500),
          parsedCount: parsedTweets.length,
          filteredCount: filteredTweets.length,
          firstParsedTweet: parsedTweets[0]
            ? {
                id: parsedTweets[0].id,
                createdAt: parsedTweets[0].createdAt,
                url: parsedTweets[0].url,
                text: parsedTweets[0].fullText.slice(0, 160),
              }
            : null,
        });
      } catch (error) {
        attempts.push({
          username: targetUsername,
          url: nitterUrl,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  return {
    targetUsernames,
    startDate: startDate.toISOString(),
    providerUrlConfigured: Boolean(getEnvString(env.TWEET_PROVIDER_URL)),
    jina,
    nitter: attempts,
  };
};

export const normalizeTweet = (raw: unknown, targetUsername: string): Tweet | null => {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const record = raw as AnyRecord;
  const id = getString(record.id, record.idStr, record.id_str, record.rest_id);
  const retweeted = (record.retweetedTweet || record.retweeted_status || {}) as AnyRecord;
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
    retweeted.fullText,
    retweeted.text,
    retweeted.tweetText,
    retweeted.content,
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
  const quoted = (record.quoted || record.quotedTweet || record.quoted_status || {}) as AnyRecord;
  const url = getString(record.url, record.tweetUrl) || `https://x.com/${target}/status/${id}`;

  return {
    id,
    url,
    createdAt,
    fullText,
    authorUsername,
    isRetweet: Boolean(record.retweetedTweet || record.retweeted_status || record.isRetweet),
    isReply: Boolean(record.replyTo || record.inReplyToStatusId || record.in_reply_to_status_id || record.isReply),
    quotedText: getString(quoted.fullText, quoted.text, quoted.tweetText) || null,
    quotedUrl: getString(quoted.url, quoted.tweetUrl) || null,
    quotedCreatedAt: normalizeDateString(getString(quoted.createdAt, quoted.created_at)) || null,
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

const getRettiwt = async (): Promise<{ Rettiwt: new (config?: { apiKey?: string; timeout?: number }) => any }> => {
  if (!rettiwtModulePromise) {
    rettiwtModulePromise = import("rettiwt-api") as Promise<{
      Rettiwt: new (config?: { apiKey?: string; timeout?: number }) => any;
    }>;
  }

  return rettiwtModulePromise;
};

const fetchFromProviderUrl = async (env: Env, startDate: Date): Promise<Tweet[]> => {
  const providerUrl = getEnvString(env.TWEET_PROVIDER_URL);

  if (!providerUrl) {
    return [];
  }

  const tweets = await Promise.all(
    getTargetUsernames(env).map(async (targetUsername) => {
      const url = new URL(providerUrl);
      url.searchParams.set("username", targetUsername);
      url.searchParams.set("startDate", startDate.toISOString());
      url.searchParams.set("limit", String(DEFAULT_SEARCH_BATCH_SIZE));

      const response = await fetch(url, {
        headers: getEnvString(env.RETTIWT_API_KEY)
          ? {
              authorization: `Bearer ${getEnvString(env.RETTIWT_API_KEY)}`,
            }
          : undefined,
      });

      if (!response.ok) {
        throw new Error(`Tweet provider returned ${response.status}`);
      }

      return normalizeTweets(await response.json(), targetUsername, startDate);
    }),
  );

  return dedupeTweetsById(tweets.flat());
};

const fetchNitterRssForUsername = async (env: Env, targetUsername: string): Promise<Tweet[]> => {
  const configuredBaseUrls = new Set(splitCsv(env.NITTER_BASE_URL).map(normalizeBaseUrl));

  for (const baseUrl of getNitterBaseUrls(env)) {
    try {
      const response = await fetchNitterRssText(baseUrl, targetUsername, configuredBaseUrls.has(baseUrl));

      if (!response.ok) {
        continue;
      }

      const tweets = dedupeTweetsById(parseNitterRssTweets(await response.text(), targetUsername));

      if (tweets.length > 0) {
        return tweets;
      }
    } catch {
      continue;
    }
  }

  return [];
};

const fetchFromNitterRss = async (env: Env, _startDate: Date): Promise<Tweet[]> => {
  const tweets = await Promise.all(
    getTargetUsernames(env).map((targetUsername) => fetchNitterRssForUsername(env, targetUsername)),
  );

  return dedupeTweetsById(tweets.flat());
};

const getConfiguredTargetUserId = (env: Env, targetUsername: string): string => {
  const targetUsernames = getTargetUsernames(env);
  const targetUserIds = splitCsv(env.TARGET_USER_IDS);
  const index = targetUsernames.indexOf(normalizeUsername(targetUsername));

  return getEnvString(targetUserIds[index], targetUsernames.length === 1 ? getEnvString(env.TARGET_USER_ID) : "");
};

const resolveTargetUserId = async (rettiwt: any, env: Env, targetUsername: string): Promise<string> => {
  const configuredUserId = getConfiguredTargetUserId(env, targetUsername);

  if (configuredUserId) {
    return configuredUserId;
  }

  const user = await rettiwt.user.details(targetUsername);
  const userId = getString(user?.id, user?.rest_id);

  if (!userId) {
    throw new Error(`Unable to resolve @${targetUsername} user ID`);
  }

  return userId;
};

const fetchFromRettiwtForUsername = async (
  rettiwt: any,
  env: Env,
  targetUsername: string,
  startDate: Date,
  fallBackOnPartialFailure = false,
): Promise<Tweet[]> => {
  const results: unknown[] = [];
  const errors: unknown[] = [];
  let fulfilledRequestCount = 0;

  try {
    results.push(
      await rettiwt.tweet.search(
        {
          fromUsers: [targetUsername],
          startDate,
        },
        DEFAULT_SEARCH_BATCH_SIZE,
      ),
    );
    fulfilledRequestCount += 1;
  } catch (error) {
    errors.push(error);
  }

  try {
    const userId = await resolveTargetUserId(rettiwt, env, targetUsername);
    const timelineResponses = await Promise.allSettled([
      rettiwt.user.timeline(userId, DEFAULT_SEARCH_BATCH_SIZE),
      rettiwt.user.replies(userId, DEFAULT_SEARCH_BATCH_SIZE),
    ]);

    for (const response of timelineResponses) {
      if (response.status === "fulfilled") {
        results.push(response.value);
        fulfilledRequestCount += 1;
      } else {
        errors.push(response.reason);
      }
    }
  } catch (error) {
    errors.push(error);
  }

  const tweets = normalizeTweets(results.flatMap(normalizeBatch), targetUsername, startDate);

  if (tweets.length > 0) {
    return tweets;
  }

  if (fallBackOnPartialFailure && errors.length > 0) {
    throw new Error(`Rettiwt authenticated fetch was incomplete: ${errors.map((error) => getErrorMessage(error)).join("; ")}`);
  }

  if (fulfilledRequestCount > 0 || errors.length === 0) {
    return tweets;
  }

  throw new Error("Rettiwt tweet fetch failed");
};

const fetchFromRettiwt = async (env: Env, startDate: Date): Promise<Tweet[]> => {
  const apiKey = getEnvString(env.RETTIWT_API_KEY);
  const { Rettiwt } = await getRettiwt();
  const rettiwt = new Rettiwt({ ...(apiKey ? { apiKey } : {}), timeout: 15_000 });
  const guestRettiwt = apiKey ? new Rettiwt({ timeout: 15_000 }) : null;
  const targetUsernames = getTargetUsernames(env);
  const responses = await Promise.allSettled(
    targetUsernames.map(async (targetUsername) => {
      try {
        return await fetchFromRettiwtForUsername(rettiwt, env, targetUsername, startDate, Boolean(apiKey));
      } catch (authenticatedError) {
        if (!guestRettiwt) {
          throw authenticatedError;
        }

        try {
          return await fetchFromRettiwtForUsername(guestRettiwt, env, targetUsername, startDate);
        } catch (guestError) {
          throw new Error(
            `@${targetUsername}: configured auth failed (${getErrorMessage(authenticatedError)}); guest auth failed (${getErrorMessage(guestError)})`,
          );
        }
      }
    }),
  );
  const tweets = responses
    .filter((response): response is PromiseFulfilledResult<Tweet[]> => response.status === "fulfilled")
    .flatMap((response) => response.value);

  if (tweets.length > 0 || responses.some((response) => response.status === "fulfilled")) {
    return dedupeTweetsById(tweets);
  }

  const failures = responses
    .map((response, index) => response.status === "rejected"
      ? `@${targetUsernames[index]}: ${getErrorMessage(response.reason)}`
      : null)
    .filter((failure): failure is string => Boolean(failure));

  throw new Error(`Rettiwt tweet fetch failed for all target usernames: ${failures.join("; ")}`);
};

const fetchTweetsSince = async (env: Env, startDate: Date): Promise<Tweet[]> => {
  const providerTweets = await fetchFromProviderUrl(env, startDate);

  if (providerTweets.length > 0) {
    return providerTweets;
  }

  try {
    const jinaTweets = await fetchFromJinaProfiles(env);

    if (jinaTweets.length > 0) {
      console.log(JSON.stringify({ event: "tweet_source_selected", source: "jina", tweetCount: jinaTweets.length }));
      return jinaTweets;
    }
  } catch (error) {
    console.warn(JSON.stringify({ event: "tweet_source_failed", source: "jina", error: getErrorMessage(error) }));
  }

  const nitterTweets = await fetchFromNitterRss(env, startDate);

  if (nitterTweets.length > 0) {
    return nitterTweets;
  }

  return fetchFromRettiwt(env, startDate);
};

export const fetchRecentTweets = async (env: Env): Promise<Tweet[]> => {
  const recentTweets = await fetchTweetsSince(env, getRecentTweetSearchStartDate(env));

  if (recentTweets.length > 0) {
    return recentTweets;
  }

  return fetchTweetsSince(env, new Date(0));
};
