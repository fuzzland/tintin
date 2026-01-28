import { RateLimiter, chunkText } from "../util.js";
import { redactText } from "../redact.js";
import type { Logger } from "../log.js";
import type {
  BaseSendMessageOpts,
  FileUploadOpts,
  IMessagingPlatform,
  InteractiveMarkup,
  MessageResult,
} from "./base.js";

export abstract class BasePlatformClient implements IMessagingPlatform {
  protected readonly limiter: RateLimiter;
  readonly maxChars: number;

  constructor(
    protected readonly logger: Logger,
    rateLimit: number,
    maxChars: number,
  ) {
    this.limiter = new RateLimiter(rateLimit);
    this.maxChars = maxChars;
  }

  abstract init(): Promise<void>;
  abstract sendMessage(opts: BaseSendMessageOpts & { markup?: InteractiveMarkup }): Promise<MessageResult | null>;
  abstract sendMessageSingle(opts: BaseSendMessageOpts & { markup?: InteractiveMarkup }): Promise<MessageResult>;
  abstract editMessage(opts: { chatId: string; messageId: string; text: string; markup?: InteractiveMarkup }): Promise<void>;
  abstract sendPhoto(opts: FileUploadOpts): Promise<MessageResult>;
  abstract sendDocument(opts: FileUploadOpts): Promise<MessageResult>;
  abstract answerInteraction(interactionId: string, text?: string): Promise<void>;
  abstract readonly platformName: "telegram" | "slack";

  protected chunkMessage(text: string): string[] {
    return chunkText(text, this.maxChars);
  }

  protected redactMessage(text: string): string {
    return redactText(text);
  }
}
