import type { Env } from "./types";

export const getEnvString = (value: string | undefined, fallback = ""): string =>
  typeof value === "string" && value.trim() ? value.trim() : fallback;

export const getTargetUsername = (env: Env): string =>
  getEnvString(env.TARGET_USERNAME, "thsottiaux").replace(/^@+/, "").toLowerCase();

const normalizeUsername = (value: string): string => value.replace(/^@+/, "").toLowerCase();

export const getTargetUsernames = (env: Env): string[] => {
  const configuredUsernames = splitCsv(env.TARGET_USERNAMES).map(normalizeUsername).filter(Boolean);
  const usernames = configuredUsernames.length > 0 ? configuredUsernames : [getTargetUsername(env)];

  return Array.from(new Set(usernames));
};

export const getNumberEnv = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

export const getBooleanEnv = (value: string | undefined, fallback = false): boolean => {
  if (typeof value !== "string" || !value.trim()) {
    return fallback;
  }

  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
};

export const splitCsv = (value: string | undefined): string[] =>
  typeof value === "string"
    ? value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean)
    : [];

export const isPublicSubscriptionsEnabled = (env: Env): boolean =>
  getBooleanEnv(env.PUBLIC_SUBSCRIPTIONS_ENABLED, false);

export const jsonResponse = (body: unknown, init: ResponseInit = {}): Response =>
  new Response(JSON.stringify(body, null, 2), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...init.headers,
    },
  });

export const getErrorMessage = (error: unknown, fallback = "Unknown error"): string => {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  if (typeof error === "string" && error.trim()) {
    return error.trim();
  }

  return fallback;
};

export const isAuthorizedBearer = (request: Request, expectedSecret: string | undefined): boolean => {
  const configured = getEnvString(expectedSecret);
  const authorization = request.headers.get("authorization") || "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  const provided = match?.[1]?.trim() || "";

  return Boolean(configured && provided && provided === configured);
};
