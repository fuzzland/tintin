export type MessagePriority = "user" | "background";

export interface BaseSendMessageOpts {
  chatId: string;
  text: string;
  threadId?: string;
  replyToMessageId?: string;
  priority?: MessagePriority;
}

export interface MessageResult {
  messageId: string;
  chatId: string;
  threadId?: string;
}

export interface InteractiveMarkup {
  type: "inline_keyboard" | "blocks";
  payload: unknown;
}

export interface FileUploadOpts {
  chatId: string;
  threadId?: string;
  replyToMessageId?: string;
  filename: string;
  file: Buffer;
  mimeType?: string;
  caption?: string;
  priority?: MessagePriority;
}

export interface IMessagingPlatform {
  init(): Promise<void>;

  sendMessage(opts: BaseSendMessageOpts & { markup?: InteractiveMarkup }): Promise<MessageResult | null>;
  sendMessageSingle(opts: BaseSendMessageOpts & { markup?: InteractiveMarkup }): Promise<MessageResult>;
  editMessage(opts: { chatId: string; messageId: string; text: string; markup?: InteractiveMarkup }): Promise<void>;

  sendPhoto(opts: FileUploadOpts): Promise<MessageResult>;
  sendDocument(opts: FileUploadOpts): Promise<MessageResult>;

  answerInteraction(interactionId: string, text?: string): Promise<void>;

  createThread?(opts: { chatId: string; name: string; iconId?: string }): Promise<string>;
  editThread?(opts: { chatId: string; threadId: string; name: string }): Promise<void>;
  getChatMember?(chatId: string, userId: string): Promise<{ status: string }>;
  setReaction?(opts: { chatId: string; messageId: string; emoji: string }): Promise<void>;

  readonly platformName: "telegram" | "slack";
  readonly maxChars: number;
}

export interface IAdvancedMessagingPlatform extends IMessagingPlatform {
  readonly supportsTokenRotation: boolean;
  readonly supportsPriorityQueuing: boolean;
  readonly supportsBatching: boolean;
}
