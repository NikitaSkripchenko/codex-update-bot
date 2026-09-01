import { listActiveChatIds } from "./subscriptions";
import type { TelegramSendResult } from "./telegram";
import type { Env } from "./types";

export const SUBSCRIBER_PAGE_SIZE = 500;
export const QUEUE_CHAT_BATCH_SIZE = 100;

const chunk = <T>(items: T[], size: number): T[][] => {
  const chunks: T[][] = [];

  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }

  return chunks;
};

const sleep = (ms: number): Promise<void> =>
  ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();

type FailedTelegramSendResult = Exclude<TelegramSendResult, { ok: true }>;

export type DeliverToRecipientsOptions = {
  delayMs?: number;
  includeTrailingDelay?: boolean;
  shouldDeliver?: (chatId: string) => boolean | Promise<boolean>;
  onSuccess?: (chatId: string) => void | Promise<void>;
  onFailure?: (chatId: string, result: FailedTelegramSendResult) => void | Promise<void>;
  formatRetryableError?: (chatId: string, result: FailedTelegramSendResult) => string;
};

export type DeliverToRecipientsResult = {
  deliveredCount: number;
  permanentFailureCount: number;
  retryableErrors: string[];
};

export const deliverToRecipients = async (
  chatIds: string[],
  send: (chatId: string) => TelegramSendResult | PromiseLike<TelegramSendResult>,
  options: DeliverToRecipientsOptions = {},
): Promise<DeliverToRecipientsResult> => {
  const retryableErrors: string[] = [];
  let deliveredCount = 0;
  let permanentFailureCount = 0;

  for (let index = 0; index < chatIds.length; index += 1) {
    const chatId = chatIds[index];

    if (options.shouldDeliver && !(await options.shouldDeliver(chatId))) {
      continue;
    }

    const result = await send(chatId);

    if (result.ok) {
      deliveredCount += 1;
      await options.onSuccess?.(chatId);
    } else {
      if (result.permanent) {
        permanentFailureCount += 1;
      } else {
        retryableErrors.push(
          options.formatRetryableError ? options.formatRetryableError(chatId, result) : result.error,
        );
      }

      await options.onFailure?.(chatId, result);
    }

    const shouldDelay =
      options.delayMs &&
      options.delayMs > 0 &&
      (options.includeTrailingDelay || index < chatIds.length - 1);

    if (shouldDelay) {
      await sleep(options.delayMs);
    }
  }

  return {
    deliveredCount,
    permanentFailureCount,
    retryableErrors,
  };
};

export const forEachActiveSubscriberChatBatch = async (
  env: Env,
  callback: (chatIds: string[]) => void | Promise<void>,
): Promise<void> => {
  let offset = 0;

  while (true) {
    const chatIds = await listActiveChatIds(env, SUBSCRIBER_PAGE_SIZE, offset);

    if (chatIds.length === 0) {
      break;
    }

    for (const chatIdBatch of chunk(chatIds, QUEUE_CHAT_BATCH_SIZE)) {
      if (chatIdBatch.length === 0) {
        continue;
      }

      await callback(chatIdBatch);
    }

    offset += chatIds.length;
  }
};
