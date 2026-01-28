import { createHmac } from "node:crypto";
import { WebClient, LogLevel as WebLogLevel } from "@slack/web-api";
import { RateLimiter, chunkText, nowMs, sleep, timingSafeEqualString } from "../util.js";
import type { Logger } from "../log.js";
import type { SlackSection } from "../config.js";
import { redactText } from "../redact.js";
import { fetchWithProxy } from "../httpClient.js";
import type {
  BaseSendMessageOpts,
  FileUploadOpts,
  IAdvancedMessagingPlatform,
  InteractiveMarkup,
  MessagePriority,
  MessageResult,
} from "./base.js";

export function verifySlackSignature(opts: {
  signingSecret: string;
  timestampHeader: string | null;
  signatureHeader: string | null;
  body: string;
}): boolean {
  const ts = opts.timestampHeader ? Number(opts.timestampHeader) : NaN;
  if (!Number.isFinite(ts)) return false;
  const ageSeconds = Math.abs(Math.floor(nowMs() / 1000) - ts);
  if (ageSeconds > 60 * 5) return false;

  if (!opts.signatureHeader) return false;
  const base = `v0:${opts.timestampHeader}:${opts.body}`;
  const digest = createHmac("sha256", opts.signingSecret).update(base).digest("hex");
  const expected = `v0=${digest}`;
  return timingSafeEqualString(expected, opts.signatureHeader);
}

const SLACK_USER_SEND_RATE_PER_SEC = 10;
const TOKEN_CACHE_TTL_MS = 60_000;
const TOKEN_REFRESH_MARGIN_SEC = 60;

type SlackAuthOpts = {
  workspaceId?: string | null;
  enterpriseId?: string | null;
  isEnterpriseInstall?: boolean;
};

export type SlackAuthContext = {
  teamId: string | null;
  enterpriseId: string | null;
  isEnterpriseInstall: boolean;
};

export type SlackTokenProvider = (context: SlackAuthContext) => Promise<{ token: string; expiresAt?: number | null }>;

type SlackLegacySendMessageOpts = {
  channel: string;
  text: string;
  thread_ts?: string;
  blocks?: unknown[];
  priority?: MessagePriority;
} & SlackAuthOpts;

type SlackBaseSendMessageOpts = BaseSendMessageOpts & { markup?: InteractiveMarkup } & SlackAuthOpts;

type SlackCompatSendMessageOpts = SlackLegacySendMessageOpts | SlackBaseSendMessageOpts;

type SlackLegacyFileUploadOpts = {
  channel: string;
  thread_ts?: string;
  filename: string;
  file: Buffer;
  mimeType?: string;
  initial_comment?: string;
  priority?: MessagePriority;
} & SlackAuthOpts;

type SlackCompatFileUploadOpts = FileUploadOpts & SlackAuthOpts;

type SlackFilesUploadResult = {
  ts: string | null;
  fileId: string | null;
};

type SlackSendMessageOpts = {
  channel: string;
  text: string;
  thread_ts?: string;
  blocks?: unknown[];
  workspaceId?: string | null;
  enterpriseId?: string | null;
  isEnterpriseInstall?: boolean;
};

type SlackSendQueueItem = {
  opts: SlackSendMessageOpts;
  combinable: boolean;
  priority: MessagePriority;
  resolve: (v: SlackSendResult) => void;
  reject: (e: unknown) => void;
};

type SlackSendResult = {
  ts: string;
};

type SlackTokenCacheEntry = {
  token: string;
  expiresAt: number | null;
  fetchedAtMs: number;
};

const slackWebLogLevel = (rawLevel: string | undefined): WebLogLevel => {
  if (rawLevel === "debug") return WebLogLevel.DEBUG;
  if (rawLevel === "info") return WebLogLevel.INFO;
  if (rawLevel === "warn") return WebLogLevel.WARN;
  return WebLogLevel.ERROR;
};

export class SlackClient implements IAdvancedMessagingPlatform {
  readonly platformName = "slack" as const;
  readonly supportsTokenRotation = false;
  readonly supportsPriorityQueuing = true;
  readonly supportsBatching = true;
  private readonly backgroundSendIntervalMs: number;
  private readonly backgroundLimiter: RateLimiter;
  private readonly userLimiter: RateLimiter;
  readonly maxChars: number;
  private readonly enableBatching = true;
  private readonly sendQueueUser: SlackSendQueueItem[] = [];
  private readonly sendQueueBackground: SlackSendQueueItem[] = [];
  private processingQueue = false;
  private nextBackgroundSendMs = 0;
  private readonly userQueueWaiters: Array<() => void> = [];
  private readonly messageTokenMap = new Map<string, string>();
  private readonly channelWorkspaceMap = new Map<string, SlackAuthContext>();
  private readonly tokenCache = new Map<string, SlackTokenCacheEntry>();
  private readonly webClients = new Map<string, WebClient>();
  private readonly webLogLevel: WebLogLevel;

  constructor(
    private readonly config: SlackSection,
    private readonly logger: Logger,
    private readonly tokenProvider: SlackTokenProvider,
    botLogLevel?: string,
  ) {
    this.backgroundSendIntervalMs = Math.max(0, config.message_queue_interval_ms);
    this.backgroundLimiter = new RateLimiter(config.rate_limit_msgs_per_sec);
    this.userLimiter = new RateLimiter(Math.max(config.rate_limit_msgs_per_sec, SLACK_USER_SEND_RATE_PER_SEC));
    this.maxChars = config.max_chars;
    this.webLogLevel = slackWebLogLevel(botLogLevel);
  }

  async init(): Promise<void> {
    return;
  }

  registerWorkspaceForChannel(channelId: string, opts: SlackAuthOpts): void {
    const ctx = this.normalizeAuthContext(opts);
    if (!ctx) return;
    this.channelWorkspaceMap.set(channelId, ctx);
  }

  sendMessage(opts: SlackBaseSendMessageOpts): Promise<MessageResult | null>;
  sendMessage(opts: SlackLegacySendMessageOpts): Promise<string | null>;
  async sendMessage(opts: SlackCompatSendMessageOpts): Promise<MessageResult | string | null> {
    const { legacy, returnBase } = this.normalizeSendMessageOpts(opts);
    const posted = await this.postMessageDetailed({
      channel: legacy.channel,
      text: legacy.text,
      thread_ts: legacy.thread_ts,
      blocks: legacy.blocks,
      blocksOnLastChunk: false,
      priority: legacy.priority,
      workspaceId: legacy.workspaceId,
      enterpriseId: legacy.enterpriseId,
      isEnterpriseInstall: legacy.isEnterpriseInstall,
    });
    if (!posted.lastTs) return null;
    return returnBase ? this.toMessageResult(legacy.channel, posted.lastTs, legacy.thread_ts) : posted.lastTs;
  }

  sendMessageSingle(opts: SlackBaseSendMessageOpts): Promise<MessageResult>;
  sendMessageSingle(opts: SlackLegacySendMessageOpts): Promise<string>;
  async sendMessageSingle(opts: SlackCompatSendMessageOpts): Promise<MessageResult | string> {
    const { legacy, returnBase } = this.normalizeSendMessageOpts(opts);
    const redacted = redactText(legacy.text);
    if (redacted.length > this.maxChars) throw new Error("sendMessageSingle text exceeds max_chars");
    const priority = legacy.priority ?? "background";
    const sent = await this.enqueueMessageSend(
      {
        channel: legacy.channel,
        text: redacted,
        thread_ts: legacy.thread_ts,
        blocks: legacy.blocks,
        workspaceId: legacy.workspaceId,
        enterpriseId: legacy.enterpriseId,
        isEnterpriseInstall: legacy.isEnterpriseInstall,
      },
      this.enableBatching && !legacy.blocks,
      priority,
    );
    return returnBase ? this.toMessageResult(legacy.channel, sent.ts, legacy.thread_ts) : sent.ts;
  }

  async editMessage(opts: {
    chatId: string;
    messageId: string;
    text: string;
    markup?: InteractiveMarkup;
    workspaceId?: string | null;
    enterpriseId?: string | null;
    isEnterpriseInstall?: boolean;
  }): Promise<void> {
    const blocks = opts.markup?.type === "blocks" ? (opts.markup.payload as unknown[]) : undefined;
    await this.updateMessage({
      channel: opts.chatId,
      ts: opts.messageId,
      text: opts.text,
      blocks,
      workspaceId: opts.workspaceId,
      enterpriseId: opts.enterpriseId,
      isEnterpriseInstall: opts.isEnterpriseInstall,
    });
  }

  sendPhoto(opts: SlackCompatFileUploadOpts): Promise<MessageResult>;
  sendPhoto(opts: SlackLegacyFileUploadOpts): Promise<MessageResult>;
  async sendPhoto(opts: SlackCompatFileUploadOpts | SlackLegacyFileUploadOpts): Promise<MessageResult> {
    const legacy = this.normalizeFileUploadOpts(opts);
    const uploaded = await this.uploadFile(legacy);
    const messageId = uploaded.ts ?? uploaded.fileId ?? "";
    return this.toMessageResult(legacy.channel, messageId, legacy.thread_ts);
  }

  sendDocument(opts: SlackCompatFileUploadOpts): Promise<MessageResult>;
  sendDocument(opts: SlackLegacyFileUploadOpts): Promise<MessageResult>;
  async sendDocument(opts: SlackCompatFileUploadOpts | SlackLegacyFileUploadOpts): Promise<MessageResult> {
    const legacy = this.normalizeFileUploadOpts(opts);
    const uploaded = await this.uploadFile(legacy);
    const messageId = uploaded.ts ?? uploaded.fileId ?? "";
    return this.toMessageResult(legacy.channel, messageId, legacy.thread_ts);
  }

  async answerInteraction(interactionId: string, text?: string): Promise<void> {
    if (!text) return;
    if (interactionId.startsWith("https://")) {
      await fetchWithProxy(interactionId, {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({ text, response_type: "ephemeral", replace_original: false }),
      });
      return;
    }
    this.logger.warn(`Slack answerInteraction unsupported: ${interactionId}`);
  }

  async postMessage(opts: {
    channel: string;
    text: string;
    thread_ts?: string;
    blocks?: unknown[];
    priority?: MessagePriority;
    workspaceId?: string | null;
    enterpriseId?: string | null;
    isEnterpriseInstall?: boolean;
  }) {
    const res = await this.postMessageDetailed({ ...opts, blocksOnLastChunk: false });
    return res.firstTs;
  }

  async postMessageDetailed(opts: {
    channel: string;
    text: string;
    thread_ts?: string;
    blocks?: unknown[];
    blocksOnLastChunk?: boolean;
    priority?: MessagePriority;
    workspaceId?: string | null;
    enterpriseId?: string | null;
    isEnterpriseInstall?: boolean;
  }): Promise<{ firstTs: string | null; lastTs: string | null; lastText: string | null }> {
    if (opts.workspaceId || opts.enterpriseId) {
      this.registerWorkspaceForChannel(opts.channel, {
        workspaceId: opts.workspaceId,
        enterpriseId: opts.enterpriseId,
        isEnterpriseInstall: opts.isEnterpriseInstall,
      });
    }
    const redacted = redactText(opts.text);
    const chunks = chunkText(redacted, this.maxChars);
    let firstTs: string | null = null;
    let lastTs: string | null = null;
    let lastText: string | null = null;
    const blocksOnLastChunk = opts.blocksOnLastChunk === true;
    const priority = opts.priority ?? "background";
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!;
      const blocks = opts.blocks
        ? blocksOnLastChunk
          ? i === chunks.length - 1
            ? opts.blocks
            : undefined
          : i === 0
            ? opts.blocks
            : undefined
        : undefined;
      const sent = await this.enqueueMessageSend(
        {
          channel: opts.channel,
          text: chunk,
          thread_ts: opts.thread_ts,
          blocks,
          workspaceId: opts.workspaceId,
          enterpriseId: opts.enterpriseId,
          isEnterpriseInstall: opts.isEnterpriseInstall,
        },
        this.enableBatching && !blocks,
        priority,
      );
      if (i === 0) firstTs = sent.ts;
      lastTs = sent.ts;
      lastText = chunk;
    }
    return { firstTs, lastTs, lastText };
  }

  async updateMessage(opts: {
    channel: string;
    ts: string;
    text: string;
    blocks?: unknown[];
    workspaceId?: string | null;
    enterpriseId?: string | null;
    isEnterpriseInstall?: boolean;
  }) {
    await this.userLimiter.waitTurn();
    const token = this.tokenForMessage(opts.channel, opts.ts) ??
      (await this.resolveToken({
        channel: opts.channel,
        workspaceId: opts.workspaceId,
        enterpriseId: opts.enterpriseId,
        isEnterpriseInstall: opts.isEnterpriseInstall,
      })).token;
    const client = this.getWebClient(token);
    await client.chat.update({
      channel: opts.channel,
      ts: opts.ts,
      text: redactText(opts.text),
      blocks: opts.blocks as any,
    });
  }

  async postEphemeral(opts: {
    channel: string;
    user: string;
    text: string;
    thread_ts?: string;
    blocks?: unknown[];
    workspaceId?: string | null;
    enterpriseId?: string | null;
    isEnterpriseInstall?: boolean;
  }) {
    const redacted = redactText(opts.text);
    const chunks = chunkText(redacted, this.maxChars);
    const { token } = await this.resolveToken({
      channel: opts.channel,
      workspaceId: opts.workspaceId,
      enterpriseId: opts.enterpriseId,
      isEnterpriseInstall: opts.isEnterpriseInstall,
    });
    const client = this.getWebClient(token);
    for (let i = 0; i < chunks.length; i++) {
      await this.userLimiter.waitTurn();
      await client.chat.postEphemeral({
        channel: opts.channel,
        user: opts.user,
        text: chunks[i],
        thread_ts: opts.thread_ts,
        blocks: (i === 0 ? opts.blocks : undefined) as any,
      });
    }
  }

  async openModal(trigger_id: string, view: unknown, auth?: SlackAuthOpts) {
    const { token } = await this.resolveToken({
      workspaceId: auth?.workspaceId,
      enterpriseId: auth?.enterpriseId,
      isEnterpriseInstall: auth?.isEnterpriseInstall,
    });
    const client = this.getWebClient(token);
    await client.views.open({ trigger_id, view: view as any });
  }

  async openConversation(opts: { users: string[] } & SlackAuthOpts): Promise<string> {
    const { token, context } = await this.resolveToken({
      workspaceId: opts.workspaceId,
      enterpriseId: opts.enterpriseId,
      isEnterpriseInstall: opts.isEnterpriseInstall,
    });
    const client = this.getWebClient(token);
    const res = await client.conversations.open({ users: opts.users.join(",") });
    const channelId = res.channel?.id;
    if (!channelId) throw new Error("Slack API conversations.open missing channel id");
    this.channelWorkspaceMap.set(channelId, context);
    return channelId;
  }

  async createThread(opts: { chatId: string; name: string; iconId?: string; workspaceId?: string | null }): Promise<string> {
    const ts = await this.postMessage({ channel: opts.chatId, text: opts.name, priority: "user", workspaceId: opts.workspaceId });
    if (!ts) throw new Error("Slack createThread failed to post root message");
    return ts;
  }

  async getChannelInfo(channel: string, auth?: SlackAuthOpts): Promise<unknown> {
    const { token } = await this.resolveToken({
      channel,
      workspaceId: auth?.workspaceId,
      enterpriseId: auth?.enterpriseId,
      isEnterpriseInstall: auth?.isEnterpriseInstall,
    });
    const client = this.getWebClient(token);
    return client.conversations.info({ channel });
  }

  async getUserInfo(user: string, auth?: SlackAuthOpts): Promise<unknown> {
    const { token } = await this.resolveToken({
      workspaceId: auth?.workspaceId,
      enterpriseId: auth?.enterpriseId,
      isEnterpriseInstall: auth?.isEnterpriseInstall,
    });
    const client = this.getWebClient(token);
    return client.users.info({ user });
  }

  async setReaction(opts: { chatId: string; messageId: string; emoji: string; workspaceId?: string | null }): Promise<void> {
    await this.userLimiter.waitTurn();
    const name = normalizeSlackEmoji(opts.emoji);
    const token = this.tokenForMessage(opts.chatId, opts.messageId) ??
      (await this.resolveToken({ channel: opts.chatId, workspaceId: opts.workspaceId })).token;
    const client = this.getWebClient(token);
    await client.reactions.add({ channel: opts.chatId, timestamp: opts.messageId, name });
  }

  async uploadFile(opts: SlackLegacyFileUploadOpts): Promise<SlackFilesUploadResult> {
    const priority = opts.priority ?? "background";
    const limiter = priority === "user" ? this.userLimiter : this.backgroundLimiter;
    await limiter.waitTurn();
    const { token, context } = await this.resolveToken({
      channel: opts.channel,
      workspaceId: opts.workspaceId,
      enterpriseId: opts.enterpriseId,
      isEnterpriseInstall: opts.isEnterpriseInstall,
    });
    const client = this.getWebClient(token);
    const uploadArgs = opts.thread_ts
      ? {
          channel_id: opts.channel,
          thread_ts: opts.thread_ts,
          filename: opts.filename,
          file: opts.file,
          initial_comment: opts.initial_comment ? redactText(opts.initial_comment) : undefined,
        }
      : {
          channel_id: opts.channel,
          filename: opts.filename,
          file: opts.file,
          initial_comment: opts.initial_comment ? redactText(opts.initial_comment) : undefined,
        };
    const response = (await client.files.uploadV2(uploadArgs as any)) as {
      files?: Array<{ files?: Array<{ id?: string; shares?: { public?: Record<string, Array<{ ts?: string; thread_ts?: string }>> } }> }>;
    };

    const completed = Array.isArray(response.files) ? response.files : [];
    const files = completed.flatMap((entry) => entry.files ?? []);
    const firstFile = files[0];
    const fileId = firstFile?.id ?? null;
    const ts = this.resolveFileShareTs(firstFile, opts.channel, opts.thread_ts);
    if (ts) this.recordMessageToken(opts.channel, ts, token);
    if (!ts && fileId) {
      this.logger.debug(`Slack files.uploadV2 missing message ts; using file id ${fileId}`);
    }
    if (opts.channel) this.channelWorkspaceMap.set(opts.channel, context);
    return { ts, fileId };
  }

  private async enqueueMessageSend(
    opts: SlackSendMessageOpts,
    combinable: boolean,
    priority: MessagePriority,
  ): Promise<SlackSendResult> {
    return new Promise<SlackSendResult>((resolve, reject) => {
      const item: SlackSendQueueItem = { opts, combinable, priority, resolve, reject };
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
        if (this.enableBatching && first.combinable) {
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
          const limiter = isBackground ? this.backgroundLimiter : this.userLimiter;
          await limiter.waitTurn();
          const result = await this.sendMessageWithFallback(first.opts);
          for (const item of batch) item.resolve(result);
        } catch (e) {
          for (const item of batch) item.reject(e);
        }
        if (isBackground) {
          this.nextBackgroundSendMs = Date.now() + this.backgroundSendIntervalMs;
        }
      }
    } finally {
      this.processingQueue = false;
    }
  }

  private async sendMessageWithFallback(payload: SlackSendMessageOpts): Promise<SlackSendResult> {
    const attempts = buildSendMessageAttempts(payload);
    let lastErr: unknown = null;
    for (const [idx, attempt] of attempts.entries()) {
      try {
        const { token, context } = await this.resolveToken({
          channel: attempt.channel,
          workspaceId: attempt.workspaceId,
          enterpriseId: attempt.enterpriseId,
          isEnterpriseInstall: attempt.isEnterpriseInstall,
        });
        const client = this.getWebClient(token);
        const res = await client.chat.postMessage({
          channel: attempt.channel,
          text: attempt.text,
          thread_ts: attempt.thread_ts,
          blocks: attempt.blocks as any,
          unfurl_links: false,
          unfurl_media: false,
        });
        const ts = res.ts ?? "";
        if (!ts) throw new Error("Slack API chat.postMessage missing ts");
        this.recordMessageToken(attempt.channel, ts, token);
        this.channelWorkspaceMap.set(attempt.channel, context);
        return { ts };
      } catch (e) {
        lastErr = e;
        this.logger.debug(
          `Slack chat.postMessage attempt ${idx + 1}/${attempts.length} failed channel=${attempt.channel} thread=${String(
            attempt.thread_ts ?? "-",
          )}: ${String(e)}`,
        );
      }
    }
    throw lastErr ?? new Error("Slack chat.postMessage failed");
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

  private recordMessageToken(channel: string, ts: string, token: string) {
    const key = this.messageTokenKey(channel, ts);
    this.messageTokenMap.set(key, token);
  }

  private tokenForMessage(channel: string, ts: string): string | null {
    const key = this.messageTokenKey(channel, ts);
    return this.messageTokenMap.get(key) ?? null;
  }

  private messageTokenKey(channel: string, ts: string): string {
    return `${channel}:${ts}`;
  }

  private normalizeAuthContext(opts?: SlackAuthOpts | null): SlackAuthContext | null {
    if (!opts) return null;
    const teamId = opts.workspaceId ?? null;
    const enterpriseId = opts.enterpriseId ?? null;
    const isEnterpriseInstall = Boolean(opts.isEnterpriseInstall ?? (!teamId && enterpriseId));
    if (!teamId && !enterpriseId) return null;
    return { teamId, enterpriseId, isEnterpriseInstall };
  }

  private resolveAuthContext(opts: SlackAuthOpts & { channel?: string }): SlackAuthContext {
    const direct = this.normalizeAuthContext(opts);
    if (direct) {
      if (opts.channel) this.channelWorkspaceMap.set(opts.channel, direct);
      return direct;
    }
    if (opts.channel) {
      const cached = this.channelWorkspaceMap.get(opts.channel);
      if (cached) return cached;
    }
    throw new Error("Slack workspace not resolved for request");
  }

  private cacheKey(context: SlackAuthContext): string {
    if (context.isEnterpriseInstall) {
      if (!context.enterpriseId) throw new Error("Slack enterprise install missing enterprise_id");
      return `E:${context.enterpriseId}`;
    }
    if (!context.teamId) throw new Error("Slack workspace install missing team_id");
    return `T:${context.teamId}`;
  }

  private async resolveToken(opts: SlackAuthOpts & { channel?: string }): Promise<{ token: string; context: SlackAuthContext }> {
    const context = this.resolveAuthContext(opts);
    const key = this.cacheKey(context);
    const nowSec = Math.floor(Date.now() / 1000);
    const cached = this.tokenCache.get(key);
    if (cached) {
      if (cached.expiresAt) {
        if (cached.expiresAt - TOKEN_REFRESH_MARGIN_SEC > nowSec) {
          return { token: cached.token, context };
        }
      } else if (Date.now() - cached.fetchedAtMs < TOKEN_CACHE_TTL_MS) {
        return { token: cached.token, context };
      }
    }
    const auth = await this.tokenProvider(context);
    if (!auth.token) throw new Error("Slack bot token missing from installation");
    this.tokenCache.set(key, {
      token: auth.token,
      expiresAt: auth.expiresAt ?? null,
      fetchedAtMs: Date.now(),
    });
    return { token: auth.token, context };
  }

  private getWebClient(token: string): WebClient {
    let client = this.webClients.get(token);
    if (!client) {
      client = new WebClient(token, { logLevel: this.webLogLevel });
      this.webClients.set(token, client);
    }
    return client;
  }

  private toMessageResult(channel: string, ts: string, threadTs?: string): MessageResult {
    return {
      messageId: ts,
      chatId: channel,
      threadId: threadTs,
    };
  }

  private normalizeSendMessageOpts(opts: SlackCompatSendMessageOpts): {
    legacy: SlackLegacySendMessageOpts;
    returnBase: boolean;
  } {
    if (this.isBaseSendMessageOpts(opts)) {
      return { legacy: this.normalizeBaseMessageOpts(opts), returnBase: true };
    }
    return { legacy: opts, returnBase: false };
  }

  private normalizeBaseMessageOpts(opts: SlackBaseSendMessageOpts): SlackLegacySendMessageOpts {
    const threadTs = opts.threadId ?? opts.replyToMessageId;
    const blocks = opts.markup?.type === "blocks" ? (opts.markup.payload as unknown[]) : undefined;
    return {
      channel: opts.chatId,
      text: opts.text,
      thread_ts: threadTs,
      blocks,
      priority: opts.priority,
      workspaceId: opts.workspaceId,
      enterpriseId: opts.enterpriseId,
      isEnterpriseInstall: opts.isEnterpriseInstall,
    };
  }

  private normalizeFileUploadOpts(opts: SlackCompatFileUploadOpts | SlackLegacyFileUploadOpts): SlackLegacyFileUploadOpts {
    if (this.isBaseFileUploadOpts(opts)) {
      return {
        channel: opts.chatId,
        thread_ts: opts.threadId ?? opts.replyToMessageId,
        filename: opts.filename,
        file: opts.file,
        mimeType: opts.mimeType,
        initial_comment: opts.caption,
        priority: opts.priority,
        workspaceId: opts.workspaceId,
        enterpriseId: opts.enterpriseId,
        isEnterpriseInstall: opts.isEnterpriseInstall,
      };
    }
    return opts;
  }

  private resolveFileShareTs(
    file:
      | {
          shares?: {
            public?: Record<string, Array<{ ts?: string; thread_ts?: string }>>;
            private?: Record<string, Array<{ ts?: string; thread_ts?: string }>>;
          };
        }
      | undefined,
    channel: string,
    threadTs?: string,
  ): string | null {
    if (!file?.shares) return null;
    const scopes = [file.shares.public, (file.shares as { private?: Record<string, Array<{ ts?: string; thread_ts?: string }>> }).private];
    for (const scope of scopes) {
      if (!scope) continue;
      const entries = scope[channel];
      if (!entries || entries.length === 0) continue;
      if (threadTs) {
        const match = entries.find((entry) => entry.thread_ts === threadTs || entry.ts === threadTs);
        if (match?.ts) return match.ts;
      }
      const first = entries.find((entry) => entry.ts);
      if (first?.ts) return first.ts;
    }
    return null;
  }

  private isBaseSendMessageOpts(opts: SlackCompatSendMessageOpts): opts is SlackBaseSendMessageOpts {
    return typeof (opts as BaseSendMessageOpts).chatId === "string";
  }

  private isBaseFileUploadOpts(opts: SlackCompatFileUploadOpts | SlackLegacyFileUploadOpts): opts is SlackCompatFileUploadOpts {
    return typeof (opts as FileUploadOpts).chatId === "string";
  }
}

function canCombine(a: SlackSendMessageOpts, b: SlackSendMessageOpts): boolean {
  return a.channel === b.channel && a.thread_ts === b.thread_ts && !a.blocks && !b.blocks;
}

function buildSendMessageAttempts(payload: SlackSendMessageOpts): SlackSendMessageOpts[] {
  if (!payload.blocks) return [payload];
  return [payload, { ...payload, blocks: undefined }];
}

function normalizeSlackEmoji(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith(":") && trimmed.endsWith(":") && trimmed.length > 2) {
    return trimmed.slice(1, -1);
  }
  const map: Record<string, string> = {
    "\u{1F44D}": "thumbsup",
    "\u{1F44E}": "thumbsdown",
    "\u{2764}\u{FE0F}": "heart",
    "\u{2705}": "white_check_mark",
    "\u{274C}": "x",
    "\u{1F389}": "tada",
    "\u{1F440}": "eyes",
  };
  return map[trimmed] ?? trimmed;
}
