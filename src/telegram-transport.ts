import type { Env } from "./types";

export type TelegramTransportSuccess<T> = { ok: true; status: number; result?: T };
export type TelegramTransportFailure = {
  ok: false;
  status: number;
  error: string;
  retryable: boolean;
  permanent: boolean;
};
export type TelegramTransportResult<T> = TelegramTransportSuccess<T> | TelegramTransportFailure;

const isPermanentTelegramError = (status: number, description: string): boolean => {
  const text = description.toLowerCase();

  return (
    status === 403 ||
    (status === 400 &&
      (text.includes("chat not found") ||
        text.includes("bot was blocked") ||
        text.includes("user is deactivated") ||
        text.includes("chat_id is empty")))
  );
};

export const callTelegram = async <T>(
  env: Pick<Env, "TELEGRAM_BOT_TOKEN">,
  method: string,
  payload: Record<string, unknown>,
  fetchFn: typeof fetch = fetch,
): Promise<TelegramTransportResult<T>> => {
  const botToken = env.TELEGRAM_BOT_TOKEN?.trim();

  if (!botToken) {
    throw new Error("Missing TELEGRAM_BOT_TOKEN");
  }

  const response = await fetchFn(`https://api.telegram.org/bot${botToken}/${method}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const body = (await response.json().catch(() => null)) as
    | {
        ok?: boolean;
        description?: string;
        result?: T;
      }
    | null;

  if (response.ok && body?.ok !== false) {
    return {
      ok: true,
      status: response.status,
      result: body?.result,
    };
  }

  const error = body?.description || `Telegram returned ${response.status}`;
  const permanent = isPermanentTelegramError(response.status, error);

  return {
    ok: false,
    status: response.status,
    error,
    permanent,
    retryable: !permanent,
  };
};
