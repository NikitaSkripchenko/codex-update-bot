import { classifyTweet, classifyTweetHeuristically, isOpenRouterFallbackRationale } from "./classifier";
import { classifyTweetWithJev, DEFAULT_JEV_MODEL, type JevClient } from "./jev-classifier";
import { runMonitor } from "./monitor";
import { createInitialMonitorState, MONITOR_STATE_KEY, normalizeMonitorState } from "./state";
import type { Classification, Env, MonitorOutcome, Tweet } from "./types";

type Settings = {
  intervalSeconds: number;
  enabled: boolean;
  mode: "offline" | "openrouter" | "jev";
  openRouterModel: string;
  jevModel: string;
};
type Alert = { tweet: Tweet; classification: Classification; at: string };
type Run = { at: string; outcome?: MonitorOutcome; error?: string };
type Data = { version: 1; tweets: Tweet[]; settings: Settings; alerts: Alert[]; runs: Run[]; kv: Record<string, string> };
type Options = { apiKey?: string; typesafeApiKey?: string; jevClient?: JevClient; save?: (data: Data) => void };
const DEFAULT_LAB_OPENROUTER_MODEL = "nvidia/nemotron-3-super-120b-a12b:free";

const freshData = (): Data => ({
  version: 1, tweets: [], alerts: [], runs: [], kv: {},
  settings: {
    intervalSeconds: 30,
    enabled: false,
    mode: "offline",
    openRouterModel: DEFAULT_LAB_OPENROUTER_MODEL,
    jevModel: DEFAULT_JEV_MODEL,
  },
});

const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a JSON object");
  return value as Record<string, unknown>;
};

export class LocalLab {
  private data: Data;
  private options: Options;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private running = false;
  private progress: { startedAt: number; tweetId: string | null; completed: number } | null = null;
  private nextRunAt: number | null = null;
  private persistenceError: string | null = null;

  constructor(saved?: unknown, options: Options = {}) {
    this.options = options;
    if (saved !== undefined) {
      const value = object(saved);
      if (value.version !== 1 || !Array.isArray(value.tweets) || !Array.isArray(value.alerts) || !Array.isArray(value.runs)) {
        throw new Error("Invalid local lab data; restore a valid backup or move the data file aside.");
      }
      object(value.kv);
      this.data = structuredClone(saved) as Data;
      const savedSettings = object(value.settings);
      this.data.settings = {
        intervalSeconds: savedSettings.intervalSeconds as number,
        enabled: savedSettings.enabled as boolean,
        mode: savedSettings.mode as Settings["mode"],
        openRouterModel: typeof savedSettings.openRouterModel === "string"
          ? savedSettings.openRouterModel
          : typeof savedSettings.model === "string" ? savedSettings.model : DEFAULT_LAB_OPENROUTER_MODEL,
        jevModel: typeof savedSettings.jevModel === "string" ? savedSettings.jevModel : DEFAULT_JEV_MODEL,
      };
      this.validateSettings(this.data.settings);
    } else {
      this.data = freshData();
    }
  }

  exportData(): Data { return structuredClone(this.data); }

  snapshot() {
    const raw = this.data.kv[MONITOR_STATE_KEY];
    return {
      ...this.exportData(), kv: undefined,
      monitor: raw ? normalizeMonitorState(JSON.parse(raw)) : createInitialMonitorState(),
      running: this.running, nextRunAt: this.nextRunAt,
      progress: this.progress,
      openRouterAvailable: Boolean(this.options.apiKey),
      jevAvailable: Boolean(this.options.typesafeApiKey),
      persistenceError: this.persistenceError,
    };
  }

  private save() {
    try {
      this.options.save?.(this.exportData());
      this.persistenceError = null;
    } catch (error) {
      this.persistenceError = error instanceof Error ? error.message : String(error);
      this.data.settings.enabled = false;
      throw error;
    }
  }

  private assertIdle() { if (this.running) throw new Error("Analysis is running; wait for it to finish."); }

  private validateSettings(settings: Settings) {
    if (!Number.isInteger(settings.intervalSeconds) || settings.intervalSeconds < 5 || settings.intervalSeconds > 86400) {
      throw new Error("Timer interval must be an integer between 5 and 86400 seconds.");
    }
    if (typeof settings.enabled !== "boolean" || !["offline", "openrouter", "jev"].includes(settings.mode)) throw new Error("Invalid timer or analysis mode.");
    for (const model of [settings.openRouterModel, settings.jevModel]) {
      if (typeof model !== "string" || !model.trim() || model.length > 200) throw new Error("Model is required (up to 200 characters).");
    }
  }

  configure(input: unknown) {
    this.assertIdle();
    const body = object(input);
    const settings = { ...this.data.settings };
    for (const key of ["intervalSeconds", "enabled", "mode", "openRouterModel", "jevModel"] as const) {
      if (key in body) Object.assign(settings, { [key]: body[key] });
    }
    this.validateSettings(settings);
    if (settings.mode === "openrouter" && !this.options.apiKey) throw new Error("Set OPENROUTER_API_KEY in .env.lab and restart the server.");
    if (settings.mode === "jev" && !this.options.typesafeApiKey) throw new Error("Set TYPESAFE_API_KEY in .env.lab and restart the server.");
    this.data.settings = settings;
    this.save();
    this.schedule();
  }

  addTweet(input: unknown) {
    this.assertIdle();
    const body = object(input);
    const fullText = typeof body.fullText === "string" ? body.fullText.trim() : "";
    const authorUsername = typeof body.authorUsername === "string" ? body.authorUsername.trim().replace(/^@/, "").toLowerCase() : "";
    if (!fullText || fullText.length > 10000) throw new Error("Tweet text must contain 1–10000 characters.");
    if (!/^[a-z0-9_]{1,15}$/.test(authorUsername)) throw new Error("Invalid author username.");
    if (this.data.tweets.length >= 500) throw new Error("Local timeline is full (500 tweets). Reset it to continue.");
    const createdAt = body.createdAt ? String(body.createdAt) : new Date().toISOString();
    if (!Number.isFinite(Date.parse(createdAt))) throw new Error("Invalid tweet date.");
    if (body.quotedText !== undefined && (typeof body.quotedText !== "string" || body.quotedText.length > 10000)) throw new Error("Invalid quoted text.");
    if (body.isReply !== undefined && typeof body.isReply !== "boolean") throw new Error("Invalid reply flag.");
    const maxId = this.data.tweets.reduce((max, tweet) => BigInt(tweet.id) > max ? BigInt(tweet.id) : max, BigInt(Date.now()) * 1000n);
    const id = String(maxId + 1n);
    const tweet: Tweet = {
      id, fullText, authorUsername, createdAt: new Date(createdAt).toISOString(),
      url: `https://x.com/${authorUsername}/status/${id}`,
      isReply: body.isReply === true, isRetweet: false,
      quotedText: typeof body.quotedText === "string" ? body.quotedText.trim() : null,
    };
    this.data.tweets.push(tweet);
    this.save();
    return tweet;
  }

  reset() {
    this.assertIdle();
    this.stop();
    this.data = freshData();
    this.save();
    this.start();
  }

  start() { this.started = true; this.schedule(); }
  stop() {
    this.started = false;
    if (this.timer !== null) clearTimeout(this.timer);
    this.nextRunAt = null;
  }

  private schedule() {
    if (this.timer !== null) clearTimeout(this.timer);
    this.nextRunAt = null;
    if (!this.started || !this.data.settings.enabled || this.running) return;
    this.nextRunAt = Date.now() + this.data.settings.intervalSeconds * 1000;
    this.timer = setTimeout(() => {
      void this.run().catch((error) => { console.error("Local analysis failed:", error instanceof Error ? error.message : error); });
    }, this.data.settings.intervalSeconds * 1000);
  }

  async run(): Promise<MonitorOutcome> {
    this.assertIdle();
    this.running = true;
    this.progress = { startedAt: Date.now(), tweetId: null, completed: 0 };
    if (this.timer !== null) clearTimeout(this.timer);
    this.nextRunAt = null;
    const at = new Date().toISOString();
    // The process mutex handles exclusivity. Persist only monitor state, never a stale lock.
    const transient = new Map<string, string>();
    const kv = {
      get: async (key: string) => key === MONITOR_STATE_KEY ? this.data.kv[key] ?? null : transient.get(key) ?? null,
      put: async (key: string, value: string) => {
        if (key === MONITOR_STATE_KEY) { this.data.kv[key] = value; this.save(); }
        else transient.set(key, value);
      },
      delete: async (key: string) => { transient.delete(key); },
    } as unknown as KVNamespace;
    const env: Env = {
      MONITOR_STATE: kv, TARGET_USERNAMES: "thsottiaux,sama", RECENT_DECISION_LIMIT: "500",
      OPENROUTER_API_KEY: this.options.apiKey,
      OPENROUTER_MODEL: this.data.settings.openRouterModel,
      TYPESAFE_API_KEY: this.options.typesafeApiKey,
      TYPESAFE_MODEL: this.data.settings.jevModel,
    };
    try {
      const outcome = await runMonitor(env, {
        classificationConcurrency: 3,
        fetchTweets: async () => structuredClone(this.data.tweets),
        classify: async (config, tweet) => {
          if (this.progress) this.progress.tweetId = tweet.id;
          const result = this.data.settings.mode === "offline"
            ? { ...classifyTweetHeuristically(tweet, "Offline simulation"), model: "offline / heuristic" }
            : this.data.settings.mode === "jev"
              ? await this.classifyJevWithDeadline(config, tweet)
              : await this.classifyOpenRouterWithDeadline(config, tweet);
          if (this.progress) this.progress.completed += 1;
          return result;
        },
        dispatch: async (_env, tweet, classification) => {
          if (!this.data.alerts.some((alert) => alert.tweet.id === tweet.id)) {
            this.data.alerts.unshift({ tweet, classification, at: new Date().toISOString() });
            this.save();
          }
          return { mode: "direct", deliveredCount: 1, permanentFailureCount: 0 };
        },
      });
      this.data.runs.unshift({ at, outcome });
      return outcome;
    } catch (error) {
      this.data.settings.enabled = false;
      this.data.runs.unshift({ at, error: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally {
      this.running = false;
      this.progress = null;
      this.data.runs = this.data.runs.slice(0, 100);
      try { this.save(); } finally { this.schedule(); }
    }
  }

  private async classifyJevWithDeadline(env: Env, tweet: Tweet): Promise<Classification> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Локальный таймаут 120 секунд: Jev не вернул результат.")), 120000);
    });
    try {
      return await Promise.race([
        classifyTweetWithJev(env, tweet, this.options.jevClient ? { client: this.options.jevClient } : {}),
        deadline,
      ]);
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }

  private async classifyOpenRouterWithDeadline(env: Env, tweet: Tweet): Promise<Classification> {
    const controller = new AbortController();
    let providerError = "";
    let responseStatus: number | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(providerError || `Локальный таймаут 120 секунд: OpenRouter ${responseStatus === null ? "не прислал HTTP-ответ" : `прислал HTTP ${responseStatus}, но тело ответа не завершено`}. Ошибка провайдера не получена.`));
      }, 120000);
    });
    try {
      const result = await Promise.race([
        deadline,
        classifyTweet(env, tweet, async (input, init) => {
          controller.signal.throwIfAborted();
          const body = JSON.parse(String(init?.body));
          body.max_tokens = 512;
          body.reasoning = { enabled: false };
          const response = await fetch(input, { ...init, body: JSON.stringify(body), signal: controller.signal });
          responseStatus = response.status;
          const raw = await response.text();
          let parsed: { error?: unknown } | null = null;
          try { parsed = JSON.parse(raw); } catch { /* Preserve the non-JSON provider body below. */ }
          if (!response.ok || parsed?.error || !parsed) {
            const safeBody = env.OPENROUTER_API_KEY ? raw.split(env.OPENROUTER_API_KEY).join("[REDACTED]") : raw;
            providerError = `OpenRouter HTTP ${response.status}: ${safeBody.trim().slice(0, 8000) || "Пустое тело ответа"}`;
          } else providerError = "";
          return new Response(raw, { status: response.status, headers: response.headers });
        }),
      ]);
      if (isOpenRouterFallbackRationale(result.rationale)) throw new Error(providerError || `Модель не вернула результат: ${result.rationale}`);
      return result;
    } catch (error) {
      if (providerError) throw new Error(providerError);
      throw error;
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }
}
