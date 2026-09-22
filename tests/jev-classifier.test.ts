import { classifyTweetWithJev, type JevClient } from "../src/jev-classifier";
import type { Tweet } from "../src/types";

const tweet: Tweet = {
  id: "1",
  url: "https://x.com/sama/status/1",
  createdAt: "2026-09-21T10:00:00.000Z",
  fullText: "We have replenished everyone's Codex allowance.",
  authorUsername: "sama",
  isRetweet: false,
  isReply: false,
  quotedText: null,
};

describe("Jev classifier", () => {
  it("asks Jev to choose the production classification verdict", async () => {
    const requests: unknown[] = [];
    const client: JevClient = {
      systemOne: async (request) => {
        requests.push(request);
        return {
          model: "jev-1.13.0",
          answers: {
            verdict: {
              type: "choice",
              choice: "reset_confirmed",
              confidence: 0.94,
              probabilities: {
                reset_confirmed: 0.96,
                not_reset: 0.01,
                uncertain: 0.03,
              },
            },
          },
          usage: { input_tokens: 321, output_tokens: 34 },
        };
      },
    };

    const classification = await classifyTweetWithJev(
      {
        MONITOR_STATE: {} as KVNamespace,
        TYPESAFE_API_KEY: "typesafe-key",
        TYPESAFE_MODEL: "jev-1.13.0",
      },
      tweet,
      { client },
    );

    expect(requests).toEqual([
      {
        model: "jev-1.13.0",
        state: {
          tweet: {
            authorUsername: "sama",
            createdAt: "2026-09-21T10:00:00.000Z",
            fullText: "We have replenished everyone's Codex allowance.",
            isReply: false,
            quotedCreatedAt: null,
            quotedText: null,
            quotedUrl: null,
            url: "https://x.com/sama/status/1",
          },
        },
        questions: {
          verdict: {
            type: "choice",
            instructions: expect.any(Object),
            criteria: {
              reset_confirmed: expect.any(Object),
              not_reset: expect.any(Object),
              uncertain: expect.any(Object),
            },
          },
        },
      },
    ]);
    expect(classification).toEqual({
      verdict: "reset_confirmed",
      confidence: 0.94,
      probabilities: {
        reset_confirmed: 0.96,
        not_reset: 0.01,
        uncertain: 0.03,
      },
      rationale: "Jev classifies the post as a confirmed usage-limit reset.",
      model: "jev-1.13.0",
      usage: {
        inputTokens: 321,
        outputTokens: 34,
        reasoningTokens: 0,
        totalTokens: 355,
      },
    });
  });

  it("requires a TypeSafe API key", async () => {
    await expect(
      classifyTweetWithJev({ MONITOR_STATE: {} as KVNamespace }, tweet),
    ).rejects.toThrow("Missing TYPESAFE_API_KEY");
  });

  it("rejects an unexpected Jev verdict", async () => {
    const client = {
      systemOne: async () => ({
        model: "jev-1.13.0",
        answers: {
          verdict: {
            type: "choice" as const,
            choice: "other",
            confidence: 0.5,
            probabilities: { other: 1 },
          },
        },
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    } as unknown as JevClient;

    await expect(
      classifyTweetWithJev(
        { MONITOR_STATE: {} as KVNamespace, TYPESAFE_API_KEY: "typesafe-key" },
        tweet,
        { client },
      ),
    ).rejects.toThrow("TypeSafe returned an invalid classification verdict");
  });

  it("keeps a personal countdown as confirmed when Jev classifies it as the monitored reset", async () => {
    const client: JevClient = {
      systemOne: async () => ({
        model: "jev-1.13.0",
        answers: { verdict: { type: "choice", choice: "reset_confirmed", confidence: 0.9, probabilities: { reset_confirmed: 0.95, not_reset: 0.03, uncertain: 0.02 } } },
        usage: { input_tokens: 100, output_tokens: 20 },
      }),
    };
    const result = await classifyTweetWithJev(
      { MONITOR_STATE: {} as KVNamespace, TYPESAFE_API_KEY: "key" },
      { ...tweet, fullText: "My Codex limit resets in three hours." },
      { client },
    );

    expect(result.verdict).toBe("reset_confirmed");
    expect(result.rationale).toContain("confirmed usage-limit reset");
    expect(result.model).toBe("jev-1.13.0");
  });

  it("does not veto a definite reset announcement for all accounts", async () => {
    const client: JevClient = {
      systemOne: async () => ({
        model: "jev-1.13.0",
        answers: { verdict: { type: "choice", choice: "reset_confirmed", confidence: 0.9, probabilities: { reset_confirmed: 0.95, not_reset: 0.03, uncertain: 0.02 } } },
        usage: { input_tokens: 100, output_tokens: 20 },
      }),
    };
    const result = await classifyTweetWithJev(
      { MONITOR_STATE: {} as KVNamespace, TYPESAFE_API_KEY: "key" },
      { ...tweet, fullText: "We will reset Codex limits for all accounts in three hours." },
      { client },
    );

    expect(result.verdict).toBe("reset_confirmed");
  });
});
