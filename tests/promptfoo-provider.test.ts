import ClassifierProvider from "../evals/classifier-provider";
import type { Classification, Env, Tweet } from "../src/types";

const result: Classification = {
  verdict: "reset_confirmed",
  confidence: 0.91,
  rationale: "Confirmed reset.",
  model: "test-model",
  usage: {
    inputTokens: 100,
    outputTokens: 10,
    reasoningTokens: 0,
    totalTokens: 110,
  },
};

const vars = {
  authorUsername: "sama",
  createdAt: "2026-09-21T10:00:00.000Z",
  fullText: "Reset is live.",
  isReply: false,
  quotedCreatedAt: "",
  quotedText: "",
  quotedUrl: "",
  url: "https://x.com/sama/status/1",
};

describe("Promptfoo classifier provider", () => {
  it.each([
    ["production", "OPENROUTER_API_KEY", "production-key"],
    ["jev", "TYPESAFE_API_KEY", "typesafe-key"],
  ] as const)("calls the %s classifier with normalized test variables", async (classifier, keyName, keyValue) => {
    const calls: Array<{ env: Env; tweet: Tweet }> = [];
    const classify = async (env: Env, tweet: Tweet): Promise<Classification> => {
      calls.push({ env, tweet });
      return result;
    };
    const provider = new ClassifierProvider(
      { id: classifier, config: { classifier } },
      { production: classify, jev: classify },
      {
        OPENROUTER_API_KEY: "production-key",
        OPENROUTER_MODEL: "production-model",
        TYPESAFE_API_KEY: "typesafe-key",
        TYPESAFE_MODEL: "jev-1.13.0",
      },
    );

    const response = await provider.callApi("ignored", { vars });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.env).toMatchObject({
      [keyName]: keyValue,
    });
    expect(calls[0]?.tweet).toEqual({
      id: "eval-case",
      url: "https://x.com/sama/status/1",
      createdAt: "2026-09-21T10:00:00.000Z",
      fullText: "Reset is live.",
      authorUsername: "sama",
      isRetweet: false,
      isReply: false,
      quotedCreatedAt: null,
      quotedText: null,
      quotedUrl: null,
    });
    expect(response).toEqual({
      output: "reset_confirmed",
      tokenUsage: { prompt: 100, completion: 10, total: 110 },
      metadata: {
        confidence: 0.91,
        model: "test-model",
        rationale: "Confirmed reset.",
      },
    });
  });

  it("returns a provider error instead of a successful empty result", async () => {
    const provider = new ClassifierProvider(
      { id: "jev", config: { classifier: "jev" } },
      {
        production: async () => result,
        jev: async () => {
          throw new Error("TypeSafe unavailable");
        },
      },
      { TYPESAFE_API_KEY: "typesafe-key" },
    );

    await expect(provider.callApi("ignored", { vars })).resolves.toEqual({
      error: "TypeSafe unavailable",
    });
  });

  it("does not score a production heuristic fallback as a model answer", async () => {
    const provider = new ClassifierProvider(
      { id: "production", config: { classifier: "production" } },
      {
        production: async () => ({
          ...result,
          rationale: "OpenRouter returned 429; The post explicitly says limits were reset.",
        }),
        jev: async () => result,
      },
      { OPENROUTER_API_KEY: "production-key" },
    );

    await expect(provider.callApi("ignored", { vars })).resolves.toEqual({
      error: "OpenRouter returned 429; The post explicitly says limits were reset.",
    });
  });
});
