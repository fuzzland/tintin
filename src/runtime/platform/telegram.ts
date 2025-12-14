import { RateLimiter, chunkText, sleep } from "../util.js";
import type { Logger } from "../log.js";
import type { ProjectEntry, TelegramSection } from "../config.js";
import { redactText } from "../redact.js";

const TELEGRAM_BACKGROUND_SEND_INTERVAL_MS = 3_000;

class TelegramApiError extends Error {
  constructor(
    readonly errorCode: number,
    readonly description: string,
  ) {
    super(`Telegram API error (${errorCode}): ${description}`);
  }
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  channel_post?: TelegramMessage;
  edited_channel_post?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

export interface TelegramUser {
  id: number;
  username?: string;
  first_name?: string;
  last_name?: string;
}

export interface TelegramChat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
  title?: string;
  is_forum?: boolean;
}

export interface TelegramMessageEntity {
  type: string;
  offset: number;
  length: number;
  custom_emoji_id?: string;
}

export interface TelegramMessage {
  message_id: number;
  date: number;
  chat: TelegramChat;
  from?: TelegramUser;
  sender_chat?: TelegramChat;
  text?: string;
  entities?: TelegramMessageEntity[];
  reply_to_message?: TelegramMessage;
  message_thread_id?: number;
  is_topic_message?: boolean;
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

type TelegramApiResponse<T> = { ok: true; result: T } | { ok: false; error_code: number; description: string };

export type TelegramSendPriority = "user" | "background";

type TelegramSendQueueItem = {
  opts: TelegramSendMessageOpts;
  combinable: boolean;
  resolve: (v: TelegramMessage) => void;
  reject: (e: unknown) => void;
};

export class TelegramClient {
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly limiter: RateLimiter;
  private readonly maxChars: number;
  private readonly allowedUpdates = [
    "message",
    "edited_message",
    "channel_post",
    "edited_channel_post",
    "callback_query",
  ];
  private readonly defaultParseMode = "Markdown" as const;
  private username: string | null = null;
  private readonly sendQueueUser: TelegramSendQueueItem[] = [];
  private readonly sendQueueBackground: TelegramSendQueueItem[] = [];
  private processingQueue = false;
  private nextBackgroundSendMs = 0;
  private readonly userQueueWaiters: Array<() => void> = [];

  constructor(
    private readonly config: TelegramSection,
    private readonly logger: Logger,
  ) {
    this.token = config.token;
    this.baseUrl = `https://api.telegram.org/bot${this.token}`;
    this.limiter = new RateLimiter(config.rate_limit_msgs_per_sec);
    this.maxChars = config.max_chars;
  }

  get botUsername(): string | null {
    return this.username;
  }

  async init(): Promise<void> {
    const me = await this.api<{ username?: string }>("getMe", {});
    this.username = me.username ?? null;

    if (this.config.mode === "poll") {
      this.logger.info("Telegram: deleting webhook (poll mode)");
      try {
        await this.api("deleteWebhook", { drop_pending_updates: false });
      } catch (e) {
        this.logger.warn("Telegram: deleteWebhook failed (continuing with polling anyway)", e);
      }
    } else if (this.config.mode === "webhook" && this.config.public_base_url) {
      const url = `${this.config.public_base_url}${this.config.webhook_path}`;
      this.logger.info(`Telegram: setting webhook to ${url}`);
      try {
        await this.api("setWebhook", {
          url,
          secret_token: this.config.webhook_secret_token,
          allowed_updates: this.allowedUpdates,
        });
      } catch (e) {
        this.logger.warn(`Telegram: setWebhook failed (continuing without webhook)`, e);
      }
    }
  }

  async answerCallbackQuery(id: string, text?: string) {
    await this.api("answerCallbackQuery", text ? { callback_query_id: id, text } : { callback_query_id: id });
  }

  async sendMessage(opts: {
    chatId: number | string;
    text: string;
    messageThreadId?: number;
    replyToMessageId?: number;
    replyMarkup?: unknown;
    priority?: TelegramSendPriority;
  }) {
    const redacted = redactText(opts.text);
    const parseMode = this.defaultParseMode;
    const sanitized = sanitizeTelegramText(redacted, parseMode, false);
    const chunks = chunkText(sanitized, this.maxChars);
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!;
      await this.limiter.waitTurn();
      await this.enqueueMessageSend(
        {
          chat_id: opts.chatId,
          text: chunk,
          message_thread_id: opts.messageThreadId,
          reply_to_message_id: opts.replyToMessageId,
          reply_markup: i === 0 ? opts.replyMarkup : undefined,
          disable_web_page_preview: true,
          parse_mode: parseMode,
        },
        false,
        opts.priority ?? "background",
      );
    }
  }

  async sendMessageSingle(opts: {
    chatId: number | string;
    text: string;
    messageThreadId?: number;
    replyToMessageId?: number;
    replyMarkup?: unknown;
    entities?: TelegramMessageEntity[];
    parseMode?: "MarkdownV2" | "Markdown" | "HTML";
    priority?: TelegramSendPriority;
  }): Promise<TelegramMessage> {
    const redacted = redactText(opts.text);
    if (opts.entities && redacted !== opts.text) {
      throw new Error("sendMessageSingle cannot apply entities when redaction changes the text");
    }
    const parseMode = opts.parseMode ?? this.defaultParseMode;
    const sanitized = sanitizeTelegramText(redacted, parseMode, !!opts.entities);
    if (sanitized.length > this.maxChars) throw new Error("sendMessageSingle text exceeds max_chars");
    await this.limiter.waitTurn();
    const combinable = !opts.replyMarkup && !opts.entities;
    return this.enqueueMessageSend(
      {
        chat_id: opts.chatId,
        text: sanitized,
        message_thread_id: opts.messageThreadId,
        reply_to_message_id: opts.replyToMessageId,
        reply_markup: opts.replyMarkup,
        entities: opts.entities,
        parse_mode: parseMode,
        disable_web_page_preview: true,
      },
      combinable,
      opts.priority ?? "background",
    );
  }

  async sendMessageStrict(opts: {
    chatId: number | string;
    text: string;
    messageThreadId?: number;
    replyToMessageId?: number;
    replyMarkup?: unknown;
    entities?: TelegramMessageEntity[];
    priority?: TelegramSendPriority;
  }) {
    const redacted = redactText(opts.text);
    const parseMode = this.defaultParseMode;
    const sanitized = sanitizeTelegramText(redacted, parseMode, !!opts.entities);
    const chunks = chunkText(sanitized, this.maxChars);
    if (opts.entities) throw new Error("sendMessageStrict does not support entities (use sendMessageSingleStrict)");
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!;
      await this.limiter.waitTurn();
      await this.enqueueMessageSend(
        {
          chat_id: opts.chatId,
          text: chunk,
          message_thread_id: opts.messageThreadId,
          reply_to_message_id: opts.replyToMessageId,
          reply_markup: i === 0 ? opts.replyMarkup : undefined,
          disable_web_page_preview: true,
          parse_mode: parseMode,
        },
        false,
        opts.priority ?? "background",
      );
    }
  }

  async sendMessageSingleStrict(opts: {
    chatId: number | string;
    text: string;
    messageThreadId?: number;
    replyToMessageId?: number;
    replyMarkup?: unknown;
    entities?: TelegramMessageEntity[];
    parseMode?: "MarkdownV2" | "Markdown" | "HTML";
    priority?: TelegramSendPriority;
  }): Promise<TelegramMessage> {
    const redacted = redactText(opts.text);
    if (opts.entities && redacted !== opts.text) {
      throw new Error("sendMessageSingleStrict cannot apply entities when redaction changes the text");
    }
    const parseMode = opts.parseMode ?? this.defaultParseMode;
    const sanitized = sanitizeTelegramText(redacted, parseMode, !!opts.entities);
    if (sanitized.length > this.maxChars) throw new Error("sendMessageSingleStrict text exceeds max_chars");
    await this.limiter.waitTurn();
    const combinable = !opts.replyMarkup && !opts.entities;
    return this.enqueueMessageSend(
      {
        chat_id: opts.chatId,
        text: sanitized,
        message_thread_id: opts.messageThreadId,
        reply_to_message_id: opts.replyToMessageId,
        reply_markup: opts.replyMarkup,
        entities: opts.entities,
        parse_mode: parseMode,
        disable_web_page_preview: true,
      },
      combinable,
      opts.priority ?? "background",
    );
  }

  async createForumTopic(chatId: number | string, name: string, iconCustomEmojiId?: string): Promise<number> {
    const res = await this.api<{ message_thread_id: number }>("createForumTopic", {
      chat_id: chatId,
      name,
      icon_custom_emoji_id: iconCustomEmojiId,
    });
    return res.message_thread_id;
  }

  async getForumTopicIconStickers(): Promise<Array<{ emoji?: string; custom_emoji_id?: string }>> {
    return this.api("getForumTopicIconStickers", {});
  }

  async editForumTopic(chatId: number | string, messageThreadId: number, name: string): Promise<void> {
    await this.api("editForumTopic", { chat_id: chatId, message_thread_id: messageThreadId, name });
  }

  async pinChatMessage(chatId: number | string, messageId: number, disableNotification = true): Promise<void> {
    await this.limiter.waitTurn();
    await this.api("pinChatMessage", {
      chat_id: chatId,
      message_id: messageId,
      disable_notification: disableNotification,
    });
  }

  async getChatMember(chatId: number | string, userId: number | string): Promise<{ status: string }> {
    return this.api("getChatMember", { chat_id: chatId, user_id: userId });
  }

  projectKeyboard(projects: ProjectEntry[]) {
    return {
      inline_keyboard: projects.map((p) => [{ text: p.name, callback_data: `proj:${p.id}` }]),
    };
  }

  isMentionOrCommand(message: TelegramMessage): boolean {
    const text = message.text ?? "";
    if (text.startsWith("/codex")) return true;
    const username = this.username;
    if (!username) return false;
    if (text.includes(`@${username}`)) return true;
    return false;
  }

  async getUpdates(opts: { offset?: number; timeoutSeconds?: number }): Promise<TelegramUpdate[]> {
    const payload: Record<string, unknown> = {
      allowed_updates: this.allowedUpdates,
      timeout: typeof opts.timeoutSeconds === "number" ? opts.timeoutSeconds : this.config.poll_timeout_seconds,
    };
    if (typeof opts.offset === "number") payload.offset = opts.offset;
    return this.api("getUpdates", payload);
  }

  async setMessageReaction(opts: { chatId: number | string; messageId: number; emoji: string; isBig?: boolean }) {
    await this.limiter.waitTurn();
    const reaction = [{ type: "emoji", emoji: opts.emoji }];
    await this.api("setMessageReaction", {
      chat_id: opts.chatId,
      message_id: opts.messageId,
      reaction,
      is_big: opts.isBig ?? false,
    });
  }

  private async api<T>(method: string, payload: unknown): Promise<T> {
    let attempts = 0;
    while (true) {
      try {
        const res = await fetch(`${this.baseUrl}/${method}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
        const json = (await res.json()) as TelegramApiResponse<T>;
        if (!json.ok) {
          throw new TelegramApiError(json.error_code, json.description);
        }
        return json.result;
      } catch (e) {
        const retryAfter = parseRetryAfterSeconds(e);
        if (retryAfter !== null && attempts < 3) {
          const delayMs = Math.max(TELEGRAM_BACKGROUND_SEND_INTERVAL_MS, retryAfter * 1000 + 500);
          this.logger.warn(`Telegram 429, retrying after ${delayMs}ms`);
          await sleep(delayMs);
          attempts++;
          continue;
        }
        throw e;
      }
    }
  }

  private async sendMessageWithFallback(payload: TelegramSendMessageOpts): Promise<TelegramMessage> {
    const attempts = buildSendMessageAttempts(payload);
    let lastErr: unknown = null;

    for (const [idx, attempt] of attempts.entries()) {
      try {
        return await this.api("sendMessage", attempt);
      } catch (e) {
        lastErr = e;
        if (e instanceof TelegramApiError) {
          const chatId = attempt.chat_id;
          const threadId = attempt.message_thread_id;
          const replyId = attempt.reply_to_message_id;
          this.logger.debug(
            `Telegram sendMessage attempt ${idx + 1}/${attempts.length} failed chat=${String(chatId)} thread=${String(
              threadId ?? "-",
            )} reply=${String(replyId ?? "-")}: ${e.description}`,
          );
        } else {
          this.logger.debug(`Telegram sendMessage attempt ${idx + 1}/${attempts.length} failed: ${String(e)}`);
        }
      }
    }

    throw lastErr;
  }

  private notifyUserQueueWaiters() {
    const waiters = this.userQueueWaiters.splice(0);
    for (const w of waiters) w();
  }

  private waitForUserQueueSignal(): { promise: Promise<void>; cancel: () => void } {
    if (this.sendQueueUser.length > 0) return { promise: Promise.resolve(), cancel: () => {} };
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    this.userQueueWaiters.push(resolve);
    const cancel = () => {
      const idx = this.userQueueWaiters.indexOf(resolve);
      if (idx >= 0) this.userQueueWaiters.splice(idx, 1);
    };
    return { promise, cancel };
  }

  private async enqueueMessageSend(
    opts: TelegramSendMessageOpts,
    combinable: boolean,
    priority: TelegramSendPriority,
  ): Promise<TelegramMessage> {
    return new Promise<TelegramMessage>((resolve, reject) => {
      const item: TelegramSendQueueItem = { opts, combinable, resolve, reject };
      if (priority === "user") {
        this.sendQueueUser.push(item);
        this.notifyUserQueueWaiters();
      } else {
        this.sendQueueBackground.push(item);
      }
      void this.processQueue();
    });
  }

  private async processQueue() {
    if (this.processingQueue) return;
    this.processingQueue = true;
    try {
      while (this.sendQueueUser.length > 0 || this.sendQueueBackground.length > 0) {
        if (this.sendQueueUser.length === 0 && this.sendQueueBackground.length > 0) {
          const now = Date.now();
          if (now < this.nextBackgroundSendMs) {
            const waitMs = this.nextBackgroundSendMs - now;
            const signal = this.waitForUserQueueSignal();
            try {
              await Promise.race([sleep(waitMs), signal.promise]);
            } finally {
              signal.cancel();
            }
            continue;
          }
        }

        const queue = this.sendQueueUser.length > 0 ? this.sendQueueUser : this.sendQueueBackground;
        const isBackground = queue === this.sendQueueBackground;
        const first = queue.shift()!;
        const batch = [first];
        if (first.combinable) {
          let combinedText = first.opts.text;
          while (queue.length > 0) {
            const next = queue[0];
            if (!next) break;
            if (!next.combinable) break;
            if (!canCombine(first.opts, next.opts)) break;
            const candidate = `${combinedText}\n\n${next.opts.text}`;
            if (candidate.length > this.maxChars) break;
            combinedText = candidate;
            batch.push(queue.shift()!);
          }
          if (batch.length > 1) {
            first.opts = { ...first.opts, text: combinedText };
          }
        }

        try {
          const result = await this.sendMessageWithFallback(first.opts);
          for (const item of batch) item.resolve(result);
        } catch (e) {
          for (const item of batch) item.reject(e);
        }
        if (isBackground) {
          this.nextBackgroundSendMs = Date.now() + TELEGRAM_BACKGROUND_SEND_INTERVAL_MS;
        }
      }
    } finally {
      this.processingQueue = false;
    }
  }
}

interface TelegramSendMessageOpts {
  chat_id: number | string;
  text: string;
  message_thread_id?: number;
  reply_to_message_id?: number;
  reply_markup?: unknown;
  entities?: TelegramMessageEntity[];
  parse_mode?: "MarkdownV2" | "Markdown" | "HTML";
  disable_web_page_preview?: boolean;
}

function canCombine(a: TelegramSendMessageOpts, b: TelegramSendMessageOpts): boolean {
  return (
    a.chat_id === b.chat_id &&
    a.message_thread_id === b.message_thread_id &&
    a.reply_to_message_id === b.reply_to_message_id &&
    a.parse_mode === b.parse_mode &&
    !a.reply_markup &&
    !b.reply_markup &&
    !a.entities &&
    !b.entities
  );
}

function parseRetryAfterSeconds(err: unknown): number | null {
  if (err instanceof TelegramApiError && err.errorCode === 429) {
    const m = err.description.match(/retry after\s+(\d+)/i);
    if (m) {
      const n = Number(m[1]);
      return Number.isFinite(n) ? n : null;
    }
    return 5;
  }
  return null;
}

function sanitizeTelegramText(
  text: string,
  parseMode: "MarkdownV2" | "Markdown" | "HTML" | undefined,
  hasEntities: boolean,
): string {
  if (hasEntities) return text;
  if (parseMode === "Markdown") return escapeTelegramMarkdown(text);
  return text;
}

function escapeTelegramMarkdown(text: string): string {
  let out = "";
  let inTriple = false;
  let inInline = false;

  for (let i = 0; i < text.length; i++) {
    if (!inInline && text.startsWith("```", i)) {
      inTriple = !inTriple;
      out += "```";
      i += 2;
      continue;
    }

    const ch = text[i];
    if (!inTriple && ch === "`") {
      inInline = !inInline;
      out += ch;
      continue;
    }

    const prev = text[i - 1];
    if (!inTriple && !inInline && ch === "_" && prev !== "\\") {
      out += "\\_";
      continue;
    }

    out += ch;
  }

  return out;
}

function buildSendMessageAttempts(payload: TelegramSendMessageOpts): TelegramSendMessageOpts[] {
  const hasThread = payload.message_thread_id !== undefined && payload.message_thread_id !== null;
  const hasReply = payload.reply_to_message_id !== undefined && payload.reply_to_message_id !== null;

  const base: TelegramSendMessageOpts[] = [payload];

  if (hasReply) base.push({ ...payload, reply_to_message_id: undefined });
  if (hasThread) base.push({ ...payload, message_thread_id: undefined });
  if (hasThread || hasReply) base.push({ ...payload, message_thread_id: undefined, reply_to_message_id: undefined });

  // For Markdown/HTML parsing failures, retry without parse_mode and/or entities.
  const attempts: TelegramSendMessageOpts[] = [];
  for (const a of base) {
    attempts.push(a);
    if (a.parse_mode !== undefined) attempts.push({ ...a, parse_mode: undefined });
    if (a.entities !== undefined) attempts.push({ ...a, entities: undefined });
    if (a.parse_mode !== undefined && a.entities !== undefined) attempts.push({ ...a, parse_mode: undefined, entities: undefined });
  }

  const seen = new Set<string>();
  const out: TelegramSendMessageOpts[] = [];
  for (const a of attempts) {
    const key = `${String(a.chat_id)}|${String(a.message_thread_id ?? "-")}|${String(a.reply_to_message_id ?? "-")}|${String(
      a.parse_mode ?? "-",
    )}|${a.entities !== undefined ? "ent" : "-"}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(a);
  }
  return out;
}
