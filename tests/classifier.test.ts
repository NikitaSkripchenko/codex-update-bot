import {
  classificationInstructions,
  classifyTweet,
  classifyTweetHeuristically,
  extractJsonObjectText,
  normalizeClassification,
} from "../src/classifier";
import type { Tweet } from "../src/types";

const tweet: Tweet = {
  id: "1",
  url: "https://x.com/thsottiaux/status/1",
  createdAt: "2026-07-07T12:00:00.000Z",
  fullText: "When is the next reset?",
  authorUsername: "thsottiaux",
  isRetweet: false,
  isReply: false,
  quotedText: "Codex rate limits have been reset.",
};

describe("classifier", () => {
  it("normalizes future-reset rationale when quoted text confirms a reset", () => {
    const classification = normalizeClassification(tweet, {
      verdict: "reset_confirmed",
      confidence: 2,
      rationale: "",
    });

    expect(classification.confidence).toBe(1);
    expect(classification.rationale).toContain("Quoted post confirms");
  });

  it("defaults invalid verdicts to uncertain", () => {
    const classification = normalizeClassification(tweet, {
      verdict: "bad" as never,
      confidence: Number.NaN,
      rationale: "",
    });

    expect(classification.verdict).toBe("uncertain");
    expect(classification.confidence).toBe(0);
  });

  it("includes contrastive few-shot examples for reset windows", () => {
    expect(classificationInstructions).toContain("When will Codex rate limits reset?");
    expect(classificationInstructions).toContain("The post asks about a reset but does not confirm one.");
    expect(classificationInstructions).toContain(
      "We will reset the rate limits again across ChatGPT Work and Codex over the next 24 hours.",
    );
    expect(classificationInstructions).toContain("The post announces rate-limit resets for Codex and ChatGPT Work.");
  });

  it("extracts JSON from fenced model output", () => {
    expect(
      extractJsonObjectText([
        "Here is the classification:",
        "```json",
        '{"verdict":"not_reset","confidence":0.9,"rationale":"No reset."}',
        "```",
      ].join("\n")),
    ).toBe('{"verdict":"not_reset","confidence":0.9,"rationale":"No reset."}');
  });

  it("calls OpenRouter chat completions", async () => {
    const requests: Request[] = [];
    const fetchFn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init);
      requests.push(request);
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: '{"verdict":"not_reset","confidence":0.88,"rationale":"No reset signal."}',
              },
            },
          ],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 5,
            total_tokens: 15,
          },
        }),
        {
          headers: { "content-type": "application/json" },
        },
      );
    };

    const classification = await classifyTweet(
      {
        MONITOR_STATE: {} as KVNamespace,
        OPENROUTER_API_KEY: "openrouter-key",
        OPENROUTER_MODEL: "test/free-model:free",
        OPENROUTER_APP_NAME: "Test Bot",
        OPENROUTER_SITE_URL: "https://example.test",
      },
      tweet,
      fetchFn as typeof fetch,
    );

    expect(classification).toMatchObject({
      verdict: "not_reset",
      confidence: 0.88,
      rationale: "No reset signal.",
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
      },
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer openrouter-key");
    expect(requests[0]?.headers.get("http-referer")).toBe("https://example.test");
    expect(requests[0]?.headers.get("x-title")).toBe("Test Bot");

    const body = await requests[0]?.json() as { model: string; messages: unknown[]; response_format: { type: string } };
    expect(body.model).toBe("test/free-model:free");
    expect(body.messages).toHaveLength(2);
    expect(body.response_format.type).toBe("json_object");
  });

  it("falls back to a conservative heuristic when OpenRouter is rate limited", async () => {
    const classification = await classifyTweet(
      {
        MONITOR_STATE: {} as KVNamespace,
        OPENROUTER_API_KEY: "openrouter-key",
      },
      {
        ...tweet,
        fullText: "Random product update unrelated to limits.",
        quotedText: null,
      },
      (async () =>
        new Response(JSON.stringify({ error: { message: "rate limited" } }), {
          status: 429,
        })) as typeof fetch,
    );

    expect(classification.verdict).toBe("uncertain");
    expect(classification.rationale).toContain("OpenRouter returned 429");
  });

  it("falls back to a conservative heuristic when OpenRouter returns empty content", async () => {
    const classification = await classifyTweet(
      {
        MONITOR_STATE: {} as KVNamespace,
        OPENROUTER_API_KEY: "openrouter-key",
        OPENROUTER_MODEL: "test/free-model:free",
      },
      {
        ...tweet,
        fullText: "Random product update unrelated to limits.",
        quotedText: null,
      },
      (async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "" } }],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 0,
              total_tokens: 10,
            },
          }),
        )) as typeof fetch,
    );

    expect(classification.verdict).toBe("uncertain");
    expect(classification.rationale).toContain("OpenRouter returned an empty classification response");
    expect(classification.model).toBe("test/free-model:free");
    expect(classification.usage?.totalTokens).toBe(10);
  });

  it("heuristic confirms explicit current reset language", () => {
    const classification = classifyTweetHeuristically({
      ...tweet,
      fullText: "Codex rate limits have reset now.",
      quotedText: null,
    });

    expect(classification.verdict).toBe("reset_confirmed");
  });

  it("heuristic stays conservative for announced reset windows", () => {
    const classification = classifyTweetHeuristically({
      ...tweet,
      fullText:
        "To celebrate the launch of GPT-5.6 Sol, we will reset the rate limits again (twice) across ChatGPT Work and Codex over the next 24 hours.",
      quotedText: null,
    });

    expect(classification.verdict).toBe("uncertain");
  });

  it("heuristic does not confirm reset questions", () => {
    const classification = classifyTweetHeuristically({
      ...tweet,
      fullText: "When will rate limits reset?",
      quotedText: null,
    });

    expect(classification.verdict).toBe("uncertain");
  });
});
