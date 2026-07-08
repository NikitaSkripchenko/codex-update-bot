import { getErrorMessage, isAuthorizedBearer, jsonResponse } from "./env";
import { runMonitor } from "./monitor";
import { readMonitorState } from "./state";
import { getSubscriptionStats } from "./subscriptions";
import { setTelegramCommands } from "./telegram";
import { getTweetSourceDiagnostics } from "./tweets";
import type { Env } from "./types";

const publicHealth = async (env: Env): Promise<Response> => {
  const state = await readMonitorState(env.MONITOR_STATE);
  const stats = await getSubscriptionStats(env);

  return jsonResponse({
    ok: !state.lastError,
    lastCheckAt: state.lastCheckAt,
    lastSeenTweetUrl: state.lastSeenTweetUrl,
    hasLastError: Boolean(state.lastError),
    recentDecisionCount: state.recentDecisions.length,
    subscriptions: stats,
  });
};

export const handleHttpRequest = async (request: Request, env: Env): Promise<Response> => {
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/health") {
    return publicHealth(env);
  }

  if (request.method === "POST" && url.pathname === "/run") {
    if (!isAuthorizedBearer(request, env.CRON_SECRET)) {
      return new Response("Unauthorized", { status: 401 });
    }

    try {
      return jsonResponse(await runMonitor(env));
    } catch (error) {
      return jsonResponse(
        {
          ok: false,
          error: getErrorMessage(error),
        },
        { status: 500 },
      );
    }
  }

  if (request.method === "POST" && url.pathname === "/telegram/commands") {
    if (!isAuthorizedBearer(request, env.CRON_SECRET)) {
      return new Response("Unauthorized", { status: 401 });
    }

    const result = await setTelegramCommands(env);
    return jsonResponse(result, { status: result.ok ? 200 : 502 });
  }

  if (request.method === "GET" && url.pathname === "/debug/tweets") {
    if (!isAuthorizedBearer(request, env.CRON_SECRET)) {
      return new Response("Unauthorized", { status: 401 });
    }

    return jsonResponse(await getTweetSourceDiagnostics(env));
  }

  if (request.method === "GET" && url.pathname === "/") {
    return new Response("Codex limit Telegram bot is running. See /health.", {
      headers: {
        "content-type": "text/plain; charset=utf-8",
      },
    });
  }

  return new Response("Not found", { status: 404 });
};
