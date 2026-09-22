import { classifyConfiguredTweet, getConfiguredClassifierKeyName, getConfiguredClassifierModel } from "../src/classification-provider";
import type { Classification, Env, Tweet } from "../src/types";

const tweet: Tweet = {
  id: "1", url: "https://x.com/sama/status/1", createdAt: "2026-09-21T10:00:00.000Z",
  fullText: "The reset is live.", authorUsername: "sama", isRetweet: false, isReply: false,
};
const result = (model: string): Classification => ({ verdict: "not_reset", confidence: 0.9, rationale: model, model });

describe("configured classifier", () => {
  it("routes Jev production traffic to Jev without calling OpenRouter", async () => {
    const calls: string[] = [];
    const env = { MONITOR_STATE: {} as KVNamespace, CLASSIFIER_PROVIDER: "jev", TYPESAFE_API_KEY: "key" };
    const classification = await classifyConfiguredTweet(env, tweet, {
      jev: async () => { calls.push("jev"); return result("jev-1.13.0"); },
      openrouter: async () => { calls.push("openrouter"); return result("openrouter"); },
    });

    expect(classification.model).toBe("jev-1.13.0");
    expect(calls).toEqual(["jev"]);
    expect(getConfiguredClassifierKeyName(env)).toBe("TYPESAFE_API_KEY");
    expect(getConfiguredClassifierModel(env)).toBe("jev-1.13.0");
  });

  it("keeps OpenRouter selectable for rollback", async () => {
    const calls: string[] = [];
    const env = { MONITOR_STATE: {} as KVNamespace, CLASSIFIER_PROVIDER: "openrouter", OPENROUTER_API_KEY: "key", OPENROUTER_MODEL: "test/model" };
    const classification = await classifyConfiguredTweet(env, tweet, {
      jev: async () => { calls.push("jev"); return result("jev"); },
      openrouter: async () => { calls.push("openrouter"); return result("test/model"); },
    });

    expect(classification.model).toBe("test/model");
    expect(calls).toEqual(["openrouter"]);
    expect(getConfiguredClassifierKeyName(env)).toBe("OPENROUTER_API_KEY");
  });

  it("rejects unknown providers instead of silently changing models", async () => {
    const env = { MONITOR_STATE: {} as KVNamespace, CLASSIFIER_PROVIDER: "unknown" };
    await expect(classifyConfiguredTweet(env, tweet)).rejects.toThrow("Unsupported CLASSIFIER_PROVIDER: unknown");
  });
});
