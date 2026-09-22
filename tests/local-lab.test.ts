import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalLab } from "../src/local-lab";
import type { JevClient } from "../src/jev-classifier";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("local test environment", () => {
  it("runs Jev with its own model and exposes confidence probabilities", async () => {
    const client: JevClient = {
      systemOne: async (request) => ({
        model: request.model,
        answers: {
          verdict: {
            type: "choice",
            choice: "reset_confirmed",
            confidence: 0.84,
            probabilities: {
              reset_confirmed: 0.87,
              not_reset: 0.05,
              uncertain: 0.08,
            },
          },
        },
        usage: { input_tokens: 40, output_tokens: 3 },
      }),
    };
    const lab = new LocalLab(undefined, { typesafeApiKey: "typesafe-key", jevClient: client });
    lab.configure({ mode: "jev", jevModel: "jev-1.13.0" });
    lab.addTweet({ fullText: "Codex limits were reset", authorUsername: "sama" });

    await lab.run();

    expect(lab.snapshot().monitor.recentDecisions[0]).toMatchObject({
      model: "jev-1.13.0",
      confidence: 0.84,
      probabilities: {
        reset_confirmed: 0.87,
        not_reset: 0.05,
        uncertain: 0.08,
      },
    });
  });

  it("shows original OpenRouter error metadata even in an HTTP 200 response", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { code: 429, message: "Provider overloaded", metadata: { provider_name: "Nvidia", raw: "capacity exhausted" } } }))));
    const lab = new LocalLab(undefined, { apiKey: "test-key" });
    lab.configure({ mode: "openrouter" });
    lab.addTweet({ fullText: "hello", authorUsername: "sama" });
    const rejected = expect(lab.run()).rejects.toThrow(/capacity exhausted/);
    await vi.advanceTimersByTimeAsync(5000);
    await rejected;
    expect(lab.snapshot().runs[0].error).toContain("Provider overloaded");
  });
  it("does not report provider fallback as a successful model analysis", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("invalid JSON")));
    const lab = new LocalLab(undefined, { apiKey: "test-key" });
    lab.configure({ mode: "openrouter", enabled: true });
    lab.addTweet({ fullText: "Codex limits are reset", authorUsername: "sama" });
    const rejection = expect(lab.run()).rejects.toThrow(/OpenRouter HTTP 200: invalid JSON/);
    await vi.advanceTimersByTimeAsync(5000);
    await rejection;
    expect(lab.snapshot().settings.enabled).toBe(false);
    expect(lab.snapshot().monitor.recentDecisions).toHaveLength(0);
    expect(lab.snapshot().alerts).toHaveLength(0);
  });
  it("bounds a stalled model call and releases the run without saving a heuristic verdict", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
    const lab = new LocalLab(undefined, { apiKey: "test-key" });
    lab.configure({ mode: "openrouter" });
    lab.addTweet({ fullText: "hello", authorUsername: "sama" });
    const run = lab.run();
    const rejection = expect(run).rejects.toThrow(/120/);
    await vi.advanceTimersByTimeAsync(120001);
    await rejection;
    expect(lab.snapshot().running).toBe(false);
    expect(lab.snapshot().monitor.recentDecisions).toHaveLength(0);
    expect(lab.snapshot().runs[0].error).toContain("120");
  });
  it("suppresses old posts and ignores unmonitored authors", async () => {
    const lab = new LocalLab();
    lab.addTweet({ fullText: "hello", authorUsername: "sama" });
    await lab.run();
    lab.addTweet({ fullText: "Codex limits are reset", authorUsername: "sama", createdAt: new Date(Date.now() - 25 * 3600000).toISOString() });
    lab.addTweet({ fullText: "Codex limits are reset", authorUsername: "someone" });
    await lab.run();
    expect(lab.snapshot().alerts).toHaveLength(0);
    expect(lab.snapshot().monitor.recentDecisions).toHaveLength(2);
    expect(lab.snapshot().monitor.recentDecisions[0].alertEligibility).toBe("historical");
  });

  it("records provider errors, releases the mutex and supports recovery and reset", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("Invalid key", { status: 401 })));
    const lab = new LocalLab(undefined, { apiKey: "test-key" });
    lab.configure({ mode: "openrouter" });
    lab.addTweet({ fullText: "hello", authorUsername: "sama" });
    await expect(lab.run()).rejects.toThrow(/401/);
    expect(lab.snapshot().runs[0].error).toContain("401");
    expect(lab.snapshot().running).toBe(false);
    lab.configure({ mode: "offline" });
    await lab.run();
    lab.reset();
    expect(lab.snapshot().tweets).toHaveLength(0);
    expect(lab.snapshot().runs).toHaveLength(0);
    expect(lab.snapshot().monitor.lastSeenTweetId).toBeNull();
    expect(lab.snapshot().settings.enabled).toBe(false);
    lab.stop();
  });

  it("seeds history, processes new tweets offline and never repeats notifications", async () => {
    const network = vi.fn(() => { throw new Error("Network forbidden"); });
    vi.stubGlobal("fetch", network);
    const lab = new LocalLab();
    lab.addTweet({ fullText: "Codex limits have been reset", authorUsername: "sama" });
    await lab.run();
    expect(lab.snapshot().monitor.recentDecisions[0].alertEligibility).toBe("initial_seed");
    expect(lab.snapshot().alerts).toHaveLength(0);
    lab.addTweet({ fullText: "Codex limits are reset", authorUsername: "sama" });
    await lab.run();
    await lab.run();
    expect(lab.snapshot().alerts).toHaveLength(1);
    expect(network).not.toHaveBeenCalled();
  });

  it("persists tweets, settings and decisions across instances", async () => {
    const lab = new LocalLab();
    lab.addTweet({ fullText: "Hello", authorUsername: "sama" });
    lab.configure({ intervalSeconds: 15, enabled: false, mode: "offline" });
    await lab.run();
    const restored = new LocalLab(JSON.parse(JSON.stringify(lab.exportData())));
    expect(restored.snapshot().tweets).toHaveLength(1);
    expect(restored.snapshot().monitor.recentDecisions).toHaveLength(1);
    expect(restored.snapshot().settings.intervalSeconds).toBe(15);
  });

  it("validates input and missing OpenRouter credentials", () => {
    const lab = new LocalLab();
    expect(() => lab.addTweet({ fullText: " ", authorUsername: "sama" })).toThrow();
    expect(() => lab.addTweet({ fullText: "hello", authorUsername: "bad/name" })).toThrow();
    expect(() => lab.configure({ intervalSeconds: 0 })).toThrow();
    expect(() => lab.configure({ mode: "openrouter" })).toThrow(/OPENROUTER/);
    expect(() => lab.configure({ mode: "jev" })).toThrow(/TYPESAFE/);
  });

  it("migrates the legacy shared model setting into separate provider models", () => {
    const original = new LocalLab().exportData();
    const legacy = {
      ...original,
      settings: {
        intervalSeconds: 30,
        enabled: false,
        mode: "offline",
        model: "legacy/openrouter-model",
      },
    };

    const restored = new LocalLab(legacy);

    expect(restored.snapshot().settings).toMatchObject({
      openRouterModel: "legacy/openrouter-model",
      jevModel: "jev-1.13.0",
    });
  });

  it("runs on a server timer, reschedules interval changes, and pauses", async () => {
    vi.useFakeTimers();
    const lab = new LocalLab();
    lab.start();
    lab.configure({ intervalSeconds: 5, enabled: true });
    await vi.advanceTimersByTimeAsync(5000);
    expect(lab.snapshot().runs).toHaveLength(1);
    lab.configure({ intervalSeconds: 10 });
    await vi.advanceTimersByTimeAsync(5000);
    expect(lab.snapshot().runs).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(lab.snapshot().runs).toHaveLength(2);
    lab.configure({ enabled: false });
    await vi.advanceTimersByTimeAsync(20000);
    expect(lab.snapshot().runs).toHaveLength(2);
    lab.stop();
  });

  it("uses the real classifier in OpenRouter mode and rejects overlapping mutations", async () => {
    let finish!: (response: Response) => void;
    const network = vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; }));
    vi.stubGlobal("fetch", network);
    const lab = new LocalLab(undefined, { apiKey: "test-key" });
    lab.configure({ mode: "openrouter" });
    lab.addTweet({ fullText: "hello", authorUsername: "sama" });
    const run = lab.run();
    await vi.waitFor(() => expect(network).toHaveBeenCalledOnce());
    expect(() => lab.reset()).toThrow(/running/i);
    await expect(lab.run()).rejects.toThrow(/running/i);
    finish(new Response(JSON.stringify({ choices: [{ message: { content: '{"verdict":"not_reset","confidence":0.9,"rationale":"Unrelated"}' } }] })));
    await run;
    expect(lab.snapshot().monitor.recentDecisions[0].confidence).toBe(0.9);
    expect(lab.snapshot().running).toBe(false);
  });
});
