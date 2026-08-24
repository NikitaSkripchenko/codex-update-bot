import { handleHttpRequest } from "../src/http";
import { dashboardReevaluateResponse } from "../src/dashboard";
import { readMonitorState, writeMonitorState } from "../src/state";
import type { Env } from "../src/types";
import { createMemoryKv } from "./memory-kv";

const createEnv = (): Env => ({
  MONITOR_STATE: createMemoryKv(),
  OPENROUTER_MODEL: "test/model",
  TARGET_USERNAMES: "thsottiaux,sama",
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("http dashboard", () => {
  it("renders Cloudflare KV monitor data and escaped tweet text", async () => {
    const env = createEnv();
    await writeMonitorState(env.MONITOR_STATE, {
      lastSeenTweetId: "1",
      lastSeenTweetUrl: "https://x.com/thsottiaux/status/1",
      lastCheckAt: "2026-07-10T12:00:00.000Z",
      lastError: null,
      recentDecisions: [
        {
          tweetId: "1",
          tweetUrl: "https://x.com/thsottiaux/status/1",
          tweetCreatedAt: "2026-07-10T11:58:00.000Z",
          tweetText: "Limits reset <script>alert(1)</script>",
          verdict: "reset_confirmed",
          confidence: 0.94,
          rationale: "The post says limits reset now.",
          model: "openrouter/test-model",
          usage: {
            inputTokens: 100,
            outputTokens: 20,
            reasoningTokens: 5,
            totalTokens: 125,
          },
          alertedAt: "2026-07-10T12:00:01.000Z",
          deliveryMode: "queued",
          queuedCount: 2,
        },
        {
          tweetId: "0",
          tweetUrl: "https://x.com/thsottiaux/status/0",
          tweetCreatedAt: "2026-07-10T11:57:00.000Z",
          tweetText: "Older cached decision.",
          verdict: "not_reset",
          confidence: 0.8,
          rationale: "Older decision.",
          alertedAt: "2026-07-10T12:00:00.000Z",
          deliveryMode: "cached",
        },
      ],
    });

    const response = await handleHttpRequest(new Request("http://localhost:8787/dashboard"), env);
    const body = await response.text();

    expect(response.headers.get("content-type")).toContain("text/html");
    expect(body).toContain("Cloudflare<br><em>data view</em>");
    expect(body).toContain("Cloudflare KV binding: MONITOR_STATE");
    expect(body).toContain("Active subscribers</dt><dd>0</dd>");
    expect(body).toContain("Reset confirmed");
    expect(body).toContain("Re-evaluate this decision");
    expect(body).toContain('data-reevaluate-tweet-id="0"');
    expect(body).toContain("openrouter/test-model");
    expect(body).toContain("100 input / 20 output / 125 total tokens");
    expect(body).toContain("Limits reset &lt;script&gt;alert(1)&lt;/script&gt;");
    expect(body).not.toContain("Limits reset <script>alert(1)</script>");
  });

  it("returns Cloudflare monitor state as json", async () => {
    const env = createEnv();
    await writeMonitorState(env.MONITOR_STATE, {
      lastSeenTweetId: null,
      lastSeenTweetUrl: null,
      lastCheckAt: null,
      lastError: null,
      recentDecisions: [],
    });

    const response = await handleHttpRequest(new Request("http://localhost:8787/dashboard.json"), env);
    const body = (await response.json()) as { model?: string; source?: string; state?: { recentDecisions?: unknown[] }; subscribers?: number };

    expect(body.model).toBe("test/model");
    expect(body.source).toBe("Cloudflare KV binding: MONITOR_STATE");
    expect(body.subscribers).toBe(0);
    expect(body.state?.recentDecisions).toEqual([]);
  });

  it("shows the active subscriber count from D1", async () => {
    const env: Env = {
      ...createEnv(),
      SUBSCRIPTIONS_DB: {
        prepare: () => ({
          first: async () => ({ active: 7, disabled: 0 }),
        }),
      } as unknown as D1Database,
    };

    const response = await handleHttpRequest(new Request("http://localhost:8787/dashboard"), env);
    const body = await response.text();

    expect(body).toContain("Active subscribers</dt><dd>7</dd>");
  });

  it("explains an empty Cloudflare KV decision log", async () => {
    const env = createEnv();

    const response = await handleHttpRequest(new Request("http://localhost:8787/dashboard"), env);
    const body = await response.text();

    expect(body).toContain("No cached decisions yet.");
    expect(body).toContain("Cloudflare KV has no cached decisions.");
    expect(body).toContain("Cached decisions</dt><dd>0</dd>");
    expect(body).toContain("Inspect raw Cloudflare KV state");
  });

  it("does not expose dashboard routes on public hosts", async () => {
    const env = createEnv();

    const htmlResponse = await handleHttpRequest(new Request("https://worker.example/dashboard"), env);
    const jsonResponse = await handleHttpRequest(new Request("https://worker.example/dashboard.json"), env);
    const reevaluateResponse = await handleHttpRequest(
      new Request("https://worker.example/dashboard/re-evaluate", { method: "POST" }),
      env,
    );

    expect(htmlResponse.status).toBe(404);
    expect(jsonResponse.status).toBe(404);
    expect(reevaluateResponse.status).toBe(404);
  });

  it("re-evaluates a selected cached decision from the local dashboard", async () => {
    const env = {
      ...createEnv(),
      OPENROUTER_API_KEY: "openrouter-key",
      OPENROUTER_MODEL: "test/recheck-model",
      PUBLIC_SUBSCRIPTIONS_ENABLED: "false",
      TELEGRAM_BOT_TOKEN: "telegram-token",
      TELEGRAM_CHAT_IDS: "123",
    };
    await writeMonitorState(env.MONITOR_STATE, {
      lastSeenTweetId: "1",
      lastSeenTweetUrl: "https://x.com/thsottiaux/status/1",
      lastCheckAt: "2026-07-10T12:00:00.000Z",
      lastError: null,
      recentDecisions: [
        {
          tweetId: "1",
          tweetUrl: "https://x.com/thsottiaux/status/1",
          tweetCreatedAt: "2026-07-10T11:58:00.000Z",
          tweetText: "Codex rate limits have reset now.",
          verdict: "not_reset",
          confidence: 0.2,
          rationale: "Old decision.",
          alertedAt: "2026-07-10T12:00:01.000Z",
          deliveryMode: "cached",
        },
        {
          tweetId: "0",
          tweetUrl: "https://x.com/thsottiaux/status/0",
          tweetCreatedAt: "2026-07-10T11:57:00.000Z",
          tweetText: "Older cached decision.",
          verdict: "not_reset",
          confidence: 0.8,
          rationale: "Older decision.",
          alertedAt: "2026-07-10T12:00:00.000Z",
          deliveryMode: "cached",
        },
      ],
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: '{"verdict":"reset_confirmed","confidence":0.96,"rationale":"The post says limits reset now."}',
                },
              },
            ],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 4,
              total_tokens: 14,
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
      ),
    );

    const response = await handleHttpRequest(
      new Request("http://localhost:8787/dashboard/re-evaluate", {
        body: JSON.stringify({ tweetId: "0" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
      env,
    );
    const body = await response.json() as { ok?: boolean; decision?: { verdict?: string; model?: string } };
    const state = await readMonitorState(env.MONITOR_STATE);

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.decision?.verdict).toBe("reset_confirmed");
    expect(body.decision?.model).toBe("test/recheck-model");
    expect(state.recentDecisions[0]?.tweetId).toBe("0");
    expect(state.recentDecisions[0]?.verdict).toBe("reset_confirmed");
    expect(state.recentDecisions.map((decision) => decision.tweetId)).toEqual(["0", "1"]);
  });

  it("does not overwrite the latest decision when OpenRouter is rate limited", async () => {
    const env = {
      ...createEnv(),
      OPENROUTER_API_KEY: "openrouter-key",
    };
    await writeMonitorState(env.MONITOR_STATE, {
      lastSeenTweetId: "1",
      lastSeenTweetUrl: "https://x.com/thsottiaux/status/1",
      lastCheckAt: "2026-07-10T12:00:00.000Z",
      lastError: null,
      recentDecisions: [
        {
          tweetId: "1",
          tweetUrl: "https://x.com/thsottiaux/status/1",
          tweetCreatedAt: "2026-07-10T11:58:00.000Z",
          tweetText: "Codex rate limits have reset now.",
          verdict: "not_reset",
          confidence: 0.2,
          rationale: "Original decision.",
          alertedAt: "2026-07-10T12:00:01.000Z",
          deliveryMode: "cached",
        },
      ],
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("rate limited", { status: 429 })));

    const response = await handleHttpRequest(
      new Request("http://localhost:8787/dashboard/re-evaluate", {
        body: JSON.stringify({ tweetId: "1" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
      env,
    );
    const body = await response.json() as { ok?: boolean; error?: string };
    const state = await readMonitorState(env.MONITOR_STATE);

    expect(response.status).toBe(503);
    expect(body.ok).toBe(false);
    expect(body.error).toContain("OpenRouter returned 429");
    expect(state.recentDecisions[0]?.rationale).toBe("Original decision.");
  });

  it("does not save or dispatch a network-error heuristic reevaluation", async () => {
    const env = {
      ...createEnv(),
      OPENROUTER_API_KEY: "openrouter-key",
    };
    await writeMonitorState(env.MONITOR_STATE, {
      lastSeenTweetId: "1",
      lastSeenTweetUrl: "https://x.com/thsottiaux/status/1",
      lastCheckAt: "2026-07-10T12:00:00.000Z",
      lastError: null,
      recentDecisions: [
        {
          tweetId: "1",
          tweetUrl: "https://x.com/thsottiaux/status/1",
          tweetCreatedAt: "2026-07-10T11:58:00.000Z",
          tweetText: "Reset has been propagated to accounts.",
          verdict: "not_reset",
          confidence: 0.2,
          rationale: "Original decision.",
          alertedAt: "2026-07-10T12:00:01.000Z",
          deliveryMode: "cached",
        },
      ],
    });
    const dispatch = vi.fn(async () => ({ mode: "queued" as const, queuedCount: 2 }));

    const response = await dashboardReevaluateResponse(
      new Request("http://localhost:8787/dashboard/re-evaluate", {
        body: JSON.stringify({ tweetId: "1" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
      env,
      {
        classify: async () => ({
          verdict: "reset_confirmed",
          confidence: 0.66,
          rationale: "OpenRouter unavailable after a network error; The post explicitly says limits were reset.",
        }),
        dispatch,
      },
    );
    const state = await readMonitorState(env.MONITOR_STATE);

    expect(response.status).toBe(503);
    expect(dispatch).not.toHaveBeenCalled();
    expect(state.recentDecisions[0]?.rationale).toBe("Original decision.");
  });

  it("dispatches an alert only when reevaluation changes a decision to reset", async () => {
    const env = {
      ...createEnv(),
      OPENROUTER_API_KEY: "openrouter-key",
    };
    await writeMonitorState(env.MONITOR_STATE, {
      lastSeenTweetId: "1",
      lastSeenTweetUrl: "https://x.com/thsottiaux/status/1",
      lastCheckAt: "2026-07-10T12:00:00.000Z",
      lastError: null,
      recentDecisions: [
        {
          tweetId: "1",
          tweetUrl: "https://x.com/thsottiaux/status/1",
          tweetCreatedAt: "2026-07-10T11:58:00.000Z",
          tweetText: "Codex rate limits have reset now.",
          verdict: "not_reset",
          confidence: 0.2,
          rationale: "Original decision.",
          alertedAt: "2026-07-10T12:00:01.000Z",
          deliveryMode: "cached",
        },
      ],
    });
    const dispatch = vi.fn(async () => ({ mode: "queued" as const, queuedCount: 2 }));
    const classification = { verdict: "reset_confirmed" as const, confidence: 0.96, rationale: "Limits are reset." };

    const response = await dashboardReevaluateResponse(
      new Request("http://localhost:8787/dashboard/re-evaluate", {
        body: JSON.stringify({ tweetId: "1" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
      env,
      { classify: async () => classification, dispatch },
    );
    const state = await readMonitorState(env.MONITOR_STATE);

    expect(response.status).toBe(200);
    expect(dispatch).toHaveBeenCalledWith(env, expect.objectContaining({ id: "1" }), classification);
    expect(state.recentDecisions[0]).toMatchObject({ deliveryMode: "queued", queuedCount: 2, verdict: "reset_confirmed" });

    await dashboardReevaluateResponse(
      new Request("http://localhost:8787/dashboard/re-evaluate", {
        body: JSON.stringify({ tweetId: "1" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
      env,
      { classify: async () => classification, dispatch },
    );

    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});
