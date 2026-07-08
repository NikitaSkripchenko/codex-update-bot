import { getEnvString } from "./env";
import type { Classification, ClassificationVerdict, Env, Tweet } from "./types";

const OPENROUTER_CHAT_COMPLETIONS_URL = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_MODEL = "nvidia/nemotron-3-super-120b-a12b:free";
const MAX_RATIONALE_LENGTH = 120;

export const classificationInstructions = `
You classify tweets from monitored X/Twitter accounts about whether Codex or ChatGPT rate limits have reset.

Return "reset_confirmed" only when the tweet or its quoted post clearly says or directly implies that user limits, caps, or rate limits have reset, been lifted, or usage is available again now.
Return "not_reset" when the tweet is unrelated, promotional, conversational, or does not mean limits were reset.
Return "uncertain" when the tweet could plausibly be about a reset but is not explicit enough to safely treat as confirmed.

Prefer caution over guessing. Replies and quote tweets may provide context, but if the reset meaning is not clear from this post and its quoted text, use "uncertain".
If the main post talks about a future or next reset, that alone is not a current reset.
If a quoted post is the evidence for "reset_confirmed", say that explicitly in the rationale.
Keep the rationale to one short sentence suitable for a Telegram alert.

Return only a JSON object with exactly these keys:
{"verdict":"reset_confirmed|not_reset|uncertain","rationale":"short sentence","confidence":0.0}
`.trim();

const normalizeWhitespace = (value: string): string => value.replace(/\s+/g, " ").trim();

const truncateRationale = (value: string, maxLength = MAX_RATIONALE_LENGTH): string => {
  if (value.length <= maxLength) {
    return value;
  }

  const clipped = value.slice(0, maxLength - 1).trimEnd();
  const boundary = clipped.lastIndexOf(" ");
  const shortened = boundary > 48 ? clipped.slice(0, boundary) : clipped;

  return `${shortened.trimEnd()}...`;
};

const hasExplicitResetLanguage = (value: string): boolean => {
  const text = normalizeWhitespace(value).toLowerCase();

  if (!text) {
    return false;
  }

  return (
    /\b(limit|limits|rate limit|rate limits|cap|caps)\b/.test(text) &&
    (/\breset\b/.test(text) ||
      /\bresetting\b/.test(text) ||
      /\bresets\b/.test(text) ||
      /\bbeen reset\b/.test(text) ||
      /\bare reset\b/.test(text))
  );
};

const isFutureResetDiscussion = (value: string): boolean => {
  const text = normalizeWhitespace(value).toLowerCase();

  if (!text) {
    return false;
  }

  return [
    /\bnext reset\b/,
    /\banother reset\b/,
    /\bwhen\b[^.]{0,48}\breset\b/,
    /\bwill\b[^.]{0,48}\breset\b/,
    /\bin less than\b[^.]{0,48}\breset\b/,
  ].some((pattern) => pattern.test(text));
};

const getFallbackRationale = (verdict: ClassificationVerdict): string => {
  if (verdict === "reset_confirmed") {
    return "Post clearly confirms limits are reset now.";
  }

  if (verdict === "uncertain") {
    return "Possible reset signal, but not explicit enough to treat as confirmed.";
  }

  return "Post does not confirm a reset.";
};

const isClassificationVerdict = (value: unknown): value is ClassificationVerdict =>
  value === "reset_confirmed" || value === "not_reset" || value === "uncertain";

const hasLimitOrResetLanguage = (value: string): boolean => {
  const text = normalizeWhitespace(value).toLowerCase();
  return /\b(limit|limits|rate limit|rate limits|cap|caps|reset|resets|resetting)\b/.test(text);
};

const clampConfidence = (value: unknown): number => {
  const parsed = typeof value === "number" ? value : Number(value);

  if (!Number.isFinite(parsed)) {
    return 0;
  }

  return Math.max(0, Math.min(1, parsed));
};

export const normalizeClassification = (tweet: Tweet, classification: Partial<Classification>): Classification => {
  const verdict = isClassificationVerdict(classification.verdict) ? classification.verdict : "uncertain";
  let rationale = normalizeWhitespace(typeof classification.rationale === "string" ? classification.rationale : "");

  if (verdict === "reset_confirmed" && isFutureResetDiscussion(tweet.fullText) && hasExplicitResetLanguage(tweet.quotedText || "")) {
    rationale = "Quoted post confirms limits already reset; this post discusses the next reset.";
  }

  if (!rationale) {
    rationale = getFallbackRationale(verdict);
  }

  return {
    verdict,
    confidence: clampConfidence(classification.confidence),
    rationale: truncateRationale(rationale),
    usage: classification.usage,
  };
};

export const classifyTweetHeuristically = (tweet: Tweet, reasonPrefix = "OpenRouter unavailable"): Classification => {
  const mainText = tweet.fullText || "";
  const quotedText = tweet.quotedText || "";

  if (hasExplicitResetLanguage(mainText) && !isFutureResetDiscussion(mainText)) {
    return normalizeClassification(tweet, {
      confidence: 0.66,
      rationale: `${reasonPrefix}; heuristic saw explicit reset language in the tweet.`,
      verdict: "reset_confirmed",
    });
  }

  if (hasExplicitResetLanguage(quotedText)) {
    return normalizeClassification(tweet, {
      confidence: 0.62,
      rationale: `${reasonPrefix}; heuristic saw explicit reset language in the quoted post.`,
      verdict: "reset_confirmed",
    });
  }

  if (hasLimitOrResetLanguage(mainText) || hasLimitOrResetLanguage(quotedText)) {
    return normalizeClassification(tweet, {
      confidence: 0.35,
      rationale: `${reasonPrefix}; heuristic saw possible limit/reset language, but no explicit reset.`,
      verdict: "uncertain",
    });
  }

  return normalizeClassification(tweet, {
    confidence: 0.5,
    rationale: `${reasonPrefix}; heuristic found no explicit reset language.`,
    verdict: "not_reset",
  });
};

export const extractJsonObjectText = (value: string): string => {
  const text = value.trim();

  if (!text) {
    return "";
  }

  if (text.startsWith("{") && text.endsWith("}")) {
    return text;
  }

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);

  if (fenced?.[1]) {
    return extractJsonObjectText(fenced[1]);
  }

  const startIndex = text.indexOf("{");

  if (startIndex < 0) {
    return "";
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = startIndex; index < text.length; index += 1) {
    const character = text[index];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (character === "\\") {
      escaped = true;
      continue;
    }

    if (character === '"') {
      inString = !inString;
      continue;
    }

    if (inString) {
      continue;
    }

    if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;

      if (depth === 0) {
        return text.slice(startIndex, index + 1);
      }
    }
  }

  return "";
};

const extractResponseText = (data: any): string => {
  const choiceContent = data?.choices?.[0]?.message?.content;

  if (typeof choiceContent === "string") {
    return choiceContent.trim();
  }

  if (Array.isArray(choiceContent)) {
    return choiceContent
      .map((entry) => (typeof entry?.text === "string" ? entry.text : ""))
      .filter(Boolean)
      .join("\n")
      .trim();
  }

  if (typeof data?.output_text === "string") {
    return data.output_text.trim();
  }

  return "";
};

export const classifyTweet = async (
  env: Env,
  tweet: Tweet,
  fetchFn: typeof fetch = fetch,
): Promise<Classification> => {
  const apiKey = getEnvString(env.OPENROUTER_API_KEY);

  if (!apiKey) {
    throw new Error("Missing OPENROUTER_API_KEY");
  }

  const headers: Record<string, string> = {
    authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
  };
  const siteUrl = getEnvString(env.OPENROUTER_SITE_URL);
  const appName = getEnvString(env.OPENROUTER_APP_NAME, "Codex Limit Telegram Bot");

  if (siteUrl) {
    headers["http-referer"] = siteUrl;
  }

  if (appName) {
    headers["x-title"] = appName;
  }

  const response = await fetchFn(OPENROUTER_CHAT_COMPLETIONS_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: getEnvString(env.OPENROUTER_MODEL, DEFAULT_MODEL),
      messages: [
        {
          role: "system",
          content: classificationInstructions,
        },
        {
          role: "user",
          content: JSON.stringify(
            {
              tweet: {
                authorUsername: tweet.authorUsername,
                createdAt: tweet.createdAt,
                fullText: tweet.fullText,
                isReply: tweet.isReply,
                quotedCreatedAt: tweet.quotedCreatedAt || null,
                quotedText: tweet.quotedText || null,
                quotedUrl: tweet.quotedUrl || null,
                url: tweet.url,
              },
            },
            null,
            2,
          ),
        },
      ],
      response_format: { type: "json_object" },
      temperature: 0,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    if ([429, 503, 529].includes(response.status)) {
      return classifyTweetHeuristically(tweet, `OpenRouter returned ${response.status}`);
    }

    throw new Error(`OpenRouter classification failed with ${response.status}: ${errorText.slice(0, 240)}`);
  }

  const data = (await response.json()) as any;
  const outputText = extractResponseText(data);

  if (!outputText) {
    throw new Error("OpenRouter returned an empty classification response");
  }

  const jsonText = extractJsonObjectText(outputText);

  if (!jsonText) {
    throw new Error("OpenRouter returned a non-JSON classification response");
  }

  const parsed = JSON.parse(jsonText) as Partial<Classification>;

  return normalizeClassification(tweet, {
    confidence: parsed.confidence,
    rationale: parsed.rationale,
    usage: {
      inputTokens: data?.usage?.prompt_tokens || 0,
      outputTokens: data?.usage?.completion_tokens || 0,
      reasoningTokens: data?.usage?.completion_tokens_details?.reasoning_tokens || 0,
      totalTokens: data?.usage?.total_tokens || 0,
    },
    verdict: parsed.verdict,
  });
};
