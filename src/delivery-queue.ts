import { getErrorMessage, getNumberEnv, isPublicSubscriptionsEnabled } from "./env";
import {
  claimDelivery,
  listActiveChatIds,
  recordDeliveryFailure,
  recordDeliverySuccess,
} from "./subscriptions";
import { formatAlertMessage, parseTelegramChatIds, sendTelegramMessage } from "./telegram";
import type { Classification, DeliveryQueueMessage, DispatchResult, Env, Tweet } from "./types";

const SUBSCRIBER_PAGE_SIZE = 500;
const QUEUE_CHAT_BATCH_SIZE = 100;

const chunk = <T>(items: T[], size: number): T[][] => {
  const chunks: T[][] = [];

  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }

  return chunks;
};

const sleep = (ms: number): Promise<void> =>
  ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();

export const getAlertId = (tweet: Tweet, classification: Classification): string =>
  `${tweet.id}:${classification.verdict}`;

const dispatchQueuedAlert = async (
  env: Env,
  tweet: Tweet,
  classification: Classification,
): Promise<DispatchResult> => {
  if (!env.SUBSCRIPTIONS_DB || !env.TELEGRAM_DELIVERY_QUEUE) {
    throw new Error("SUBSCRIPTIONS_DB and TELEGRAM_DELIVERY_QUEUE are required for public subscriptions");
  }

  const alertId = getAlertId(tweet, classification);
  let queuedCount = 0;
  let offset = 0;

  while (true) {
    const chatIds = await listActiveChatIds(env, SUBSCRIBER_PAGE_SIZE, offset);

    if (chatIds.length === 0) {
      break;
    }

    for (const chatIdBatch of chunk(chatIds, QUEUE_CHAT_BATCH_SIZE)) {
      await env.TELEGRAM_DELIVERY_QUEUE.send({
        alertId,
        chatIds: chatIdBatch,
        classification,
        tweet,
      });
      queuedCount += chatIdBatch.length;
    }

    offset += chatIds.length;
  }

  console.log(JSON.stringify({ event: "telegram_alert_queued", alertId, queuedCount }));

  return {
    mode: "queued",
    queuedCount,
  };
};

const dispatchDirectAlert = async (
  env: Env,
  tweet: Tweet,
  classification: Classification,
): Promise<DispatchResult> => {
  const chatIds = parseTelegramChatIds(env);

  if (chatIds.length === 0) {
    throw new Error("Missing TELEGRAM_CHAT_IDS");
  }

  const message = formatAlertMessage(tweet, classification);
  let deliveredCount = 0;
  let permanentFailureCount = 0;
  const retryableErrors: string[] = [];

  for (const chatId of chatIds) {
    const result = await sendTelegramMessage(env, chatId, message);

    if (result.ok) {
      deliveredCount += 1;
      continue;
    }

    if (result.permanent) {
      permanentFailureCount += 1;
      continue;
    }

    retryableErrors.push(result.error);
  }

  if (retryableErrors.length > 0) {
    throw new Error(`Telegram delivery failed: ${retryableErrors.join("; ")}`);
  }

  if (deliveredCount === 0) {
    throw new Error("Telegram delivery failed: no configured chats accepted the alert");
  }

  return {
    mode: "direct",
    deliveredCount,
    permanentFailureCount,
  };
};

export const dispatchAlert = async (
  env: Env,
  tweet: Tweet,
  classification: Classification,
): Promise<DispatchResult> => {
  if (isPublicSubscriptionsEnabled(env)) {
    return dispatchQueuedAlert(env, tweet, classification);
  }

  return dispatchDirectAlert(env, tweet, classification);
};

type SubscriberDeliveryResult = {
  deliveredCount: number;
  permanentFailureCount: number;
};

const deliverQueueMessage = async (env: Env, message: DeliveryQueueMessage): Promise<SubscriberDeliveryResult> => {
  if (message.classification.verdict !== "reset_confirmed") {
    return { deliveredCount: 0, permanentFailureCount: 0 };
  }

  const text = formatAlertMessage(message.tweet, message.classification);
  const delayMs = getNumberEnv(env.TELEGRAM_SEND_DELAY_MS, 40);
  const retryableErrors: string[] = [];
  let deliveredCount = 0;
  let permanentFailureCount = 0;

  for (const chatId of message.chatIds) {
    const claimed = await claimDelivery(env, message.alertId, chatId);

    if (!claimed) {
      continue;
    }

    const result = await sendTelegramMessage(env, chatId, text);

    if (result.ok) {
      await recordDeliverySuccess(env, message.alertId, chatId);
      deliveredCount += 1;
      await sleep(delayMs);
      continue;
    }

    await recordDeliveryFailure(env, message.alertId, chatId, result.error, result.permanent);

    if (result.retryable) {
      retryableErrors.push(`${chatId}: ${result.error}`);
    } else {
      permanentFailureCount += 1;
    }

    await sleep(delayMs);
  }

  if (retryableErrors.length > 0) {
    throw new Error(`Retryable Telegram delivery failures: ${retryableErrors.join("; ")}`);
  }

  return { deliveredCount, permanentFailureCount };
};

export const dispatchSubscriberAlertNow = async (
  env: Env,
  tweet: Tweet,
  classification: Classification,
): Promise<DispatchResult> => {
  if (!env.SUBSCRIPTIONS_DB) {
    throw new Error("SUBSCRIPTIONS_DB is required for subscriber alerts");
  }

  const alertId = getAlertId(tweet, classification);
  let deliveredCount = 0;
  let permanentFailureCount = 0;
  let offset = 0;

  while (true) {
    const chatIds = await listActiveChatIds(env, SUBSCRIBER_PAGE_SIZE, offset);

    if (chatIds.length === 0) {
      break;
    }

    for (const chatIdBatch of chunk(chatIds, QUEUE_CHAT_BATCH_SIZE)) {
      const result = await deliverQueueMessage(env, { alertId, chatIds: chatIdBatch, classification, tweet });
      deliveredCount += result.deliveredCount;
      permanentFailureCount += result.permanentFailureCount;
    }

    offset += chatIds.length;
  }

  console.log(JSON.stringify({ event: "telegram_alert_delivered_now", alertId, deliveredCount, permanentFailureCount }));

  return { mode: "direct", deliveredCount, permanentFailureCount };
};

export const processDeliveryBatch = async (
  batch: MessageBatch<DeliveryQueueMessage>,
  env: Env,
): Promise<void> => {
  for (const message of batch.messages) {
    try {
      await deliverQueueMessage(env, message.body);
      message.ack();
    } catch (error) {
      console.error(JSON.stringify({
        event: "telegram_queue_delivery_retry",
        alertId: message.body.alertId,
        error: getErrorMessage(error),
      }));
      message.retry();
    }
  }
};
