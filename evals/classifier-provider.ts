import { classifyTweet, isOpenRouterFallbackRationale } from "../src/classifier";
import { classifyTweetWithJev } from "../src/jev-classifier";
import type { Classification, Env, Tweet } from "../src/types";

type Classifier = (env: Env, tweet: Tweet) => Promise<Classification>;
type ClassifierName = "production" | "jev";

type ProviderOptions = {
  id?: string;
  config?: { classifier?: string };
};

type ProviderContext = {
  vars?: Record<string, unknown>;
};

type ProviderResponse =
  | {
      output: string;
      tokenUsage?: { prompt: number; completion: number; total: number };
      metadata: { confidence: number; model?: string; rationale: string };
    }
  | { error: string };

type ClassifierDependencies = Record<ClassifierName, Classifier>;
type Environment = Record<string, string | undefined>;

const defaultDependencies: ClassifierDependencies = {
  production: (env, tweet) => {
    const signal = AbortSignal.timeout(30_000);
    return classifyTweet(env, tweet, (input, init) => fetch(input, { ...init, signal }));
  },
  jev: classifyTweetWithJev,
};

const requiredString = (vars: Record<string, unknown>, name: string): string => {
  const value = vars[name];

  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Promptfoo variable ${name} must be a non-empty string`);
  }

  return value;
};

const optionalString = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value : null;

const createTweet = (vars: Record<string, unknown>): Tweet => ({
  id: "eval-case",
  url: requiredString(vars, "url"),
  createdAt: requiredString(vars, "createdAt"),
  fullText: requiredString(vars, "fullText"),
  authorUsername: requiredString(vars, "authorUsername"),
  isRetweet: false,
  isReply: vars.isReply === true || vars.isReply === "true",
  quotedCreatedAt: optionalString(vars.quotedCreatedAt),
  quotedText: optionalString(vars.quotedText),
  quotedUrl: optionalString(vars.quotedUrl),
});

const createEnv = (environment: Environment): Env => ({
  MONITOR_STATE: {} as KVNamespace,
  OPENROUTER_API_KEY: environment.OPENROUTER_API_KEY,
  OPENROUTER_MODEL: environment.OPENROUTER_MODEL,
  TYPESAFE_API_KEY: environment.TYPESAFE_API_KEY,
  TYPESAFE_MODEL: environment.TYPESAFE_MODEL,
});

const getErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export default class ClassifierProvider {
  private readonly providerId: string;
  private readonly classifier: ClassifierName;
  private readonly dependencies: ClassifierDependencies;
  private readonly environment: Environment;

  constructor(
    options: ProviderOptions = {},
    dependencies: ClassifierDependencies = defaultDependencies,
    environment: Environment = process.env,
  ) {
    const classifier = options.config?.classifier;

    if (classifier !== "production" && classifier !== "jev") {
      throw new Error("Promptfoo classifier provider requires classifier=production or classifier=jev");
    }

    this.providerId = options.id || classifier;
    this.classifier = classifier;
    this.dependencies = dependencies;
    this.environment = environment;
  }

  id(): string {
    return this.providerId;
  }

  async callApi(_prompt: string, context: ProviderContext = {}): Promise<ProviderResponse> {
    try {
      const classification = await this.dependencies[this.classifier](
        createEnv(this.environment),
        createTweet(context.vars || {}),
      );

      if (this.classifier === "production" && isOpenRouterFallbackRationale(classification.rationale)) {
        return { error: classification.rationale };
      }

      return {
        output: classification.verdict,
        ...(classification.usage
          ? {
              tokenUsage: {
                prompt: classification.usage.inputTokens,
                completion: classification.usage.outputTokens,
                total: classification.usage.totalTokens,
              },
            }
          : {}),
        metadata: {
          confidence: classification.confidence,
          model: classification.model,
          rationale: classification.rationale,
        },
      };
    } catch (error) {
      return { error: getErrorMessage(error) };
    }
  }
}
