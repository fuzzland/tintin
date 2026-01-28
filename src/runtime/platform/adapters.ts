import type { BaseSendMessageOpts, MessageResult } from "./base.js";
import type { TelegramMessage } from "./telegram.js";

type TelegramSendMessagePayload = {
  chat_id: string | number;
  text: string;
  message_thread_id?: number;
  reply_to_message_id?: number;
};

type SlackSendMessagePayload = {
  channel: string;
  text: string;
  thread_ts?: string;
};

export class TelegramToBaseAdapter {
  static toMessageResult(message: TelegramMessage): MessageResult {
    return {
      messageId: String(message.message_id),
      chatId: String(message.chat.id),
      threadId: message.message_thread_id ? String(message.message_thread_id) : undefined,
    };
  }

  static fromBaseSendOpts(opts: BaseSendMessageOpts): TelegramSendMessagePayload {
    return {
      chat_id: opts.chatId,
      text: opts.text,
      message_thread_id: opts.threadId ? Number(opts.threadId) : undefined,
      reply_to_message_id: opts.replyToMessageId ? Number(opts.replyToMessageId) : undefined,
    };
  }
}

export class SlackToBaseAdapter {
  static toMessageResult(channel: string, ts: string, threadTs?: string): MessageResult {
    return {
      messageId: ts,
      chatId: channel,
      threadId: threadTs,
    };
  }

  static fromBaseSendOpts(opts: BaseSendMessageOpts): SlackSendMessagePayload {
    return {
      channel: opts.chatId,
      text: opts.text,
      thread_ts: opts.threadId,
    };
  }
}
