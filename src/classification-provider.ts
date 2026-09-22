import { classifyTweet, DEFAULT_MODEL } from "./classifier";
import { classifyTweetWithJev, DEFAULT_JEV_MODEL } from "./jev-classifier";
import { getEnvString } from "./env";
import type { Classification, Env, Tweet } from "./types";

type Classifier = (env: Env, tweet: Tweet) => Promise<Classification>;
type ClassifierDependencies = { jev: Classifier; openrouter: Classifier };

const classifiers: ClassifierDependencies = {
  jev: classifyTweetWithJev,
  openrouter: classifyTweet,
};

export const getConfiguredClassifierProvider = (env: Env): "jev" | "openrouter" => {
  const provider = getEnvString(env.CLASSIFIER_PROVIDER, "openrouter").toLowerCase();

  if (provider !== "jev" && provider !== "openrouter") {
    throw new Error(`Unsupported CLASSIFIER_PROVIDER: ${provider}`);
  }

  return provider;
};

export const getConfiguredClassifierKeyName = (env: Env): "TYPESAFE_API_KEY" | "OPENROUTER_API_KEY" =>
  getConfiguredClassifierProvider(env) === "jev" ? "TYPESAFE_API_KEY" : "OPENROUTER_API_KEY";

export const getConfiguredClassifierModel = (env: Env): string =>
  getConfiguredClassifierProvider(env) === "jev"
    ? getEnvString(env.TYPESAFE_MODEL, DEFAULT_JEV_MODEL)
    : getEnvString(env.OPENROUTER_MODEL, DEFAULT_MODEL);

export const classifyConfiguredTweet = async (
  env: Env,
  tweet: Tweet,
  deps: ClassifierDependencies = classifiers,
): Promise<Classification> => deps[getConfiguredClassifierProvider(env)](env, tweet);
