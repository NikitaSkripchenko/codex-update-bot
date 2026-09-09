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
  it.each(["reset is out now", "The reset is live!", "Reset is now available.", "  RESET   IS OUT NOW!  "])(
    "confirms a short current reset announcement: %s", (fullText) => {
      expect(classifyTweetHeuristically({ ...tweet, authorUsername: "sama", fullText, quotedText: null }).verdict)
        .toBe("reset_confirmed");
    },
  );

  it.each([
    "reset is out now?", "Is the reset live?", "reset is not out now",
    "Maybe reset is out now", "If reset is out now, let me know",
    "reset will be out soon", "Password reset is out now", "Factory reset is live",
  ])("does not confirm a question, speculation or unrelated reset: %s", (fullText) => {
    expect(classifyTweetHeuristically({ ...tweet, fullText, quotedText: null }).verdict)
      .not.toBe("reset_confirmed");
    expect(classifyTweetHeuristically({ ...tweet, fullText: "FYI", quotedText: fullText }).verdict)
      .not.toBe("reset_confirmed");
  });

  it("recognizes a short announcement in quoted text", () => {
    const result = classifyTweetHeuristically({ ...tweet, fullText: "FYI", quotedText: "reset is out now" });
    expect(result.verdict).toBe("reset_confirmed");
    expect(result.rationale).toContain("quoted post");
  });

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
    expect(body.messages[0]).toEqual({ role: "system", content: classificationInstructions });
    expect(body.messages[1]).toMatchObject({ role: "user" });
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
      {
        random: () => 0,
        sleep: async () => undefined,
      },
    );

    expect(classification.verdict).toBe("uncertain");
    expect(classification.rationale).toContain("OpenRouter returned 429");
  });

  it("falls back to a conservative heuristic when OpenRouter returns empty content", async () => {
    const requests: Request[] = [];
    const delays: number[] = [];
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
      (async (input, init) => {
        requests.push(new Request(input, init));
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: "" } }],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 0,
              total_tokens: 10,
            },
          }),
        );
      }) as typeof fetch,
      {
        random: () => 0,
        sleep: async (delayMs) => {
          delays.push(delayMs);
        },
      },
    );

    expect(classification.verdict).toBe("uncertain");
    expect(classification.rationale).toContain("OpenRouter returned an empty classification response");
    expect(classification.model).toBe("test/free-model:free");
    expect(classification.usage?.totalTokens).toBe(10);
    expect(requests).toHaveLength(3);
    expect(delays).toEqual([500, 1000]);
  });

  it("retries empty model output and uses the next valid classification", async () => {
    let attempt = 0;
    const delays: number[] = [];

    const classification = await classifyTweet(
      {
        MONITOR_STATE: {} as KVNamespace,
        OPENROUTER_API_KEY: "openrouter-key",
      },
      tweet,
      (async () => {
        attempt += 1;
        return new Response(
          JSON.stringify(
            attempt === 1
              ? { choices: [{ message: { content: "" } }] }
              : {
                  choices: [
                    {
                      message: {
                        content:
                          '{"verdict":"reset_confirmed","confidence":0.94,"rationale":"The quoted post confirms the reset."}',
                      },
                    },
                  ],
                },
          ),
        );
      }) as typeof fetch,
      {
        random: () => 0,
        sleep: async (delayMs) => {
          delays.push(delayMs);
        },
      },
    );

    expect(classification).toMatchObject({
      verdict: "reset_confirmed",
      confidence: 0.94,
      rationale: "Quoted post confirms limits already reset; this post discusses the next reset.",
    });
    expect(attempt).toBe(2);
    expect(delays).toEqual([500]);
  });

  it("honors Retry-After with a five-second cap", async () => {
    let attempt = 0;
    const delays: number[] = [];

    const classification = await classifyTweet(
      {
        MONITOR_STATE: {} as KVNamespace,
        OPENROUTER_API_KEY: "openrouter-key",
      },
      tweet,
      (async () => {
        attempt += 1;
        if (attempt === 1) {
          return new Response(JSON.stringify({ error: { message: "rate limited" } }), {
            status: 429,
            headers: { "retry-after": "30" },
          });
        }

        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: '{"verdict":"not_reset","confidence":0.9,"rationale":"No reset signal."}',
                },
              },
            ],
          }),
        );
      }) as typeof fetch,
      {
        random: () => 0,
        sleep: async (delayMs) => {
          delays.push(delayMs);
        },
      },
    );

    expect(classification.verdict).toBe("not_reset");
    expect(attempt).toBe(2);
    expect(delays).toEqual([5000]);
  });

  it.each([503, 529])("retries OpenRouter status %i", async (status) => {
    let attempt = 0;

    const classification = await classifyTweet(
      {
        MONITOR_STATE: {} as KVNamespace,
        OPENROUTER_API_KEY: "openrouter-key",
      },
      tweet,
      (async () => {
        attempt += 1;
        if (attempt === 1) {
          return new Response(JSON.stringify({ error: { message: "temporarily unavailable" } }), { status });
        }

        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: '{"verdict":"not_reset","confidence":0.9,"rationale":"No reset signal."}',
                },
              },
            ],
          }),
        );
      }) as typeof fetch,
      {
        random: () => 0,
        sleep: async () => undefined,
      },
    );

    expect(classification.verdict).toBe("not_reset");
    expect(attempt).toBe(2);
  });

  it("does not retry an authentication failure", async () => {
    let attempt = 0;
    const delays: number[] = [];

    await expect(
      classifyTweet(
        {
          MONITOR_STATE: {} as KVNamespace,
          OPENROUTER_API_KEY: "invalid-key",
        },
        tweet,
        (async () => {
          attempt += 1;
          return new Response(JSON.stringify({ error: { message: "unauthorized" } }), { status: 401 });
        }) as typeof fetch,
        {
          random: () => 0,
          sleep: async (delayMs) => {
            delays.push(delayMs);
          },
        },
      ),
    ).rejects.toThrow("OpenRouter classification failed with 401");

    expect(attempt).toBe(1);
    expect(delays).toEqual([]);
  });

  it("retries a transient network failure", async () => {
    let attempt = 0;

    const classification = await classifyTweet(
      {
        MONITOR_STATE: {} as KVNamespace,
        OPENROUTER_API_KEY: "openrouter-key",
      },
      tweet,
      (async () => {
        attempt += 1;
        if (attempt === 1) {
          throw new TypeError("network unavailable");
        }

        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: '{"verdict":"not_reset","confidence":0.9,"rationale":"No reset signal."}',
                },
              },
            ],
          }),
        );
      }) as typeof fetch,
      {
        random: () => 0,
        sleep: async () => undefined,
      },
    );

    expect(classification.verdict).toBe("not_reset");
    expect(attempt).toBe(2);
  });

  it("retries a JSON classification with an invalid verdict", async () => {
    let attempt = 0;

    const classification = await classifyTweet(
      {
        MONITOR_STATE: {} as KVNamespace,
        OPENROUTER_API_KEY: "openrouter-key",
      },
      tweet,
      (async () => {
        attempt += 1;
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content:
                    attempt === 1
                      ? '{"verdict":"yes","confidence":0.9,"rationale":"Reset."}'
                      : '{"verdict":"not_reset","confidence":0.9,"rationale":"No reset signal."}',
                },
              },
            ],
          }),
        );
      }) as typeof fetch,
      {
        random: () => 0,
        sleep: async () => undefined,
      },
    );

    expect(classification.verdict).toBe("not_reset");
    expect(attempt).toBe(2);
  });

  it("heuristic confirms explicit current reset language", () => {
    const classification = classifyTweetHeuristically({
      ...tweet,
      fullText: "Codex rate limits have reset now.",
      quotedText: null,
    });

    expect(classification.verdict).toBe("reset_confirmed");
  });

  it("heuristic confirms a reset propagated to accounts", () => {
    const classification = classifyTweetHeuristically({
      ...tweet,
      fullText:
        "Good Sunday. Reset has been propagated to accounts and we landed some fixes to usage. You should feel a positive difference.",
      quotedText: null,
    });

    expect(classification.verdict).toBe("reset_confirmed");
    expect(classification.rationale).toContain("The post explicitly says limits were reset.");
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
