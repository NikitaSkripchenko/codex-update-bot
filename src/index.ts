import { processDeliveryBatch } from "./delivery-queue";
import { handleHttpRequest } from "./http";
import { runMonitor } from "./monitor";
import { RateLimiter } from "./rate-limit";
import type { DeliveryQueueMessage, Env } from "./types";
import { handleTelegramWebhook } from "./webhook";

export { RateLimiter };

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(runMonitor(env));
  },

  async queue(batch, env) {
    await processDeliveryBatch(batch, env);
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/telegram/webhook") {
      return handleTelegramWebhook(request, env);
    }

    return handleHttpRequest(request, env);
  },
} satisfies ExportedHandler<Env, DeliveryQueueMessage>;
