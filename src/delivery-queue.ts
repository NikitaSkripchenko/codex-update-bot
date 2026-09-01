import { getErrorMessage, getNumberEnv, isPublicSubscriptionsEnabled } from "./env";
import { deliverToRecipients, forEachActiveSubscriberChatBatch } from "./alert-delivery";
import {
  claimDelivery,
  recordDeliveryFailure,
  recordDeliverySuccess,
} from "./subscriptions";
import { formatAlertMessage, parseTelegramChatIds, sendTelegramMessage } from "./telegram";
import type { Classification, DeliveryQueueMessage, DispatchResult, Env, Tweet } from "./types";

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

  await forEachActiveSubscriberChatBatch(env, async (chatIds) => {
    await env.TELEGRAM_DELIVERY_QUEUE.send({
      alertId,
      chatIds,
      classification,
      tweet,
    });
    queuedCount += chatIds.length;
  });

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
  const { deliveredCount, permanentFailureCount, retryableErrors } = await deliverToRecipients(
    chatIds,
    (chatId) => sendTelegramMessage(env, chatId, message),
  );

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
  const { deliveredCount, permanentFailureCount, retryableErrors } = await deliverToRecipients(
    message.chatIds,
    (chatId) => sendTelegramMessage(env, chatId, text),
    {
      delayMs,
      formatRetryableError: (chatId, result) => `${chatId}: ${result.error}`,
      onFailure: (chatId, result) =>
        recordDeliveryFailure(env, message.alertId, chatId, result.error, result.permanent),
      onSuccess: (chatId) => recordDeliverySuccess(env, message.alertId, chatId),
      shouldDeliver: (chatId) => claimDelivery(env, message.alertId, chatId),
    },
  );

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

  await forEachActiveSubscriberChatBatch(env, async (chatIds) => {
    const result = await deliverQueueMessage(env, { alertId, chatIds, classification, tweet });
    deliveredCount += result.deliveredCount;
    permanentFailureCount += result.permanentFailureCount;
  });

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
