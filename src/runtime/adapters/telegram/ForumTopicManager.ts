/**
 * ForumTopicManager - Manages Telegram forum topic creation and updates.
 *
 * Handles:
 * - Topic creation with custom emojis
 * - Topic header pinning
 * - Topic title updates
 * - Fallback to reply threads when topics unavailable
 */

import type { SessionAgent } from "../../db.js";
import type { Logger } from "../../log.js";
import type { TelegramClient, TelegramChat } from "../../platform/telegram.js";
import type { UserLanguage } from "../../../locales/index.js";
import { t } from "../../../locales/index.js";
import { getAgentAdapter } from "../../agents.js";

/**
 * Result of creating a session space.
 */
export interface SessionSpaceResult {
  /** The space ID (topic ID or message ID) */
  spaceId: string;
  /** Whether to announce the topic creation in the original thread */
  announce: boolean;
  /** The topic ID if a forum topic was created */
  topicId?: number;
  /** The emoji used for the topic */
  topicEmoji?: string;
  /** The custom emoji ID for the topic icon */
  topicCustomEmojiId?: string;
}

/**
 * Options for creating a session space.
 */
export interface CreateSessionSpaceOptions {
  chat: TelegramChat;
  projectName: string;
  anchorMessageId: number;
  anchorMessageThreadId?: number;
  agent: SessionAgent;
  lang: UserLanguage;
}

/**
 * Options for pinning a topic header.
 */
export interface PinTopicHeaderOptions {
  chatId: string;
  topicId: number;
  initialPrompt: string;
  sessionId: string;
  lang: UserLanguage;
}

/**
 * Options for updating a topic title.
 */
export interface UpdateTopicTitleOptions {
  chatId: string;
  topicId: number;
  topicEmoji: string;
  projectName: string;
  agent: SessionAgent;
}

export interface ForumTopicManagerDeps {
  telegram: TelegramClient;
  logger: Logger;
  /** Whether forum topics are enabled in config */
  useTopics: boolean;
  /** Maximum characters for messages */
  maxChars: number;
}

// Topic emoji pool
const TOPIC_EMOJIS = [
  "🧠", "🛠️", "🚀", "🧩", "🧪", "🧰", "📌", "📎", "📝", "🔎",
  "🧭", "⚙️", "🧵", "🗂️", "🗒️", "📦", "🛰️", "🧯", "🧱", "🔧",
  "🔨", "🪄", "🧿", "🧷", "🧬", "📡", "🧑‍💻", "🕵️", "🧾", "🗳️",
];

export class ForumTopicManager {
  constructor(private readonly deps: ForumTopicManagerDeps) {}

  /**
   * Pick a random topic emoji, preferring custom emojis if available.
   */
  async pickEmoji(): Promise<{ emoji: string; customEmojiId?: string }> {
    const fallback = { emoji: this.pickRandomEmoji() };

    try {
      const stickers = await this.deps.telegram.getForumTopicIconStickers();
      const candidates = stickers
        .map((s) => ({
          emoji: typeof s.emoji === "string" && s.emoji.length > 0 ? s.emoji : null,
          customEmojiId: typeof s.custom_emoji_id === "string" && s.custom_emoji_id.length > 0 ? s.custom_emoji_id : null,
        }))
        .filter((x): x is { emoji: string; customEmojiId: string } => !!x.emoji && !!x.customEmojiId);

      if (candidates.length === 0) return fallback;
      const idx = Math.floor(Math.random() * candidates.length);
      const picked = candidates[idx];
      return picked ?? fallback;
    } catch (e) {
      this.deps.logger.debug(`[ForumTopicManager] getForumTopicIconStickers failed: ${String(e)}`);
      return fallback;
    }
  }

  /**
   * Create a session space (forum topic or reply thread).
   */
  async createSessionSpace(opts: CreateSessionSpaceOptions): Promise<SessionSpaceResult> {
    const chatId = String(opts.chat.id);

    // Channel: reply to anchor message
    if (opts.chat.type === "channel") {
      await this.deps.telegram.sendMessageSingle({
        chatId,
        replyToMessageId: opts.anchorMessageId,
        text: t("session.created", opts.lang),
        priority: "user",
      });
      return { spaceId: String(opts.anchorMessageId), announce: false };
    }

    // Supergroup with forum: try to create topic
    if (this.deps.useTopics && opts.chat.type === "supergroup" && opts.chat.is_forum) {
      const picked = await this.pickEmoji();
      try {
        const initialName = this.clipTopicName(`${picked.emoji} ${this.agentShortName(opts.agent)}: ${opts.projectName}`);
        const topicId = await this.deps.telegram.createForumTopic(chatId, initialName, picked.customEmojiId);
        return {
          spaceId: String(topicId),
          announce: true,
          topicId,
          topicEmoji: picked.emoji,
          topicCustomEmojiId: picked.customEmojiId,
        };
      } catch (e) {
        this.deps.logger.warn(
          `[ForumTopicManager] createForumTopic failed chat=${chatId} (ensure Topics are enabled and bot can_manage_topics); falling back to reply thread: ${String(e)}`,
        );
      }
    }

    // Fallback: create reply thread
    const root = await this.deps.telegram.sendMessageSingle({
      chatId,
      messageThreadId: opts.anchorMessageThreadId,
      replyToMessageId: opts.anchorMessageId,
      text: t("session.created_reply", opts.lang),
      priority: "user",
    });
    return { spaceId: String(root.message_id), announce: false };
  }

  /**
   * Pin a header message in a forum topic.
   */
  async pinTopicHeader(opts: PinTopicHeaderOptions): Promise<void> {
    const message = this.formatTopicHeaderMessage(opts.initialPrompt, opts.sessionId, opts.lang);
    try {
      const msg = await this.deps.telegram.sendMessageSingleStrict({
        chatId: opts.chatId,
        messageThreadId: opts.topicId,
        text: message.text,
        parseMode: message.parseMode,
        replyMarkup: {
          inline_keyboard: [[{ text: t("button.stop", opts.lang), callback_data: `kill:${opts.sessionId}` }]],
        },
        priority: "user",
      });
      await this.deps.telegram.pinChatMessage(opts.chatId, msg.message_id);
    } catch (e) {
      this.deps.logger.warn(
        `[ForumTopicManager] failed to pin topic header chat=${opts.chatId} topic=${opts.topicId} session=${opts.sessionId}: ${String(e)}`,
      );
    }
  }

  /**
   * Update a forum topic title (async, fire-and-forget).
   */
  async updateTopicTitle(opts: UpdateTopicTitleOptions): Promise<void> {
    try {
      const emojiPrefix = `${opts.topicEmoji} `;
      const maxNameChars = 128;
      const maxTitleChars = Math.max(16, maxNameChars - emojiPrefix.length);

      const title = this.truncateText(`${this.agentShortName(opts.agent)}: ${opts.projectName}`, maxTitleChars);
      const nextName = this.clipTopicName(`${emojiPrefix}${title}`);
      await this.deps.telegram.editForumTopic(opts.chatId, opts.topicId, nextName);
    } catch (e) {
      this.deps.logger.debug(`[ForumTopicManager] editForumTopic failed: ${String(e)}`);
    }
  }

  // ============================================================================
  // Private helpers
  // ============================================================================

  private pickRandomEmoji(): string {
    if (TOPIC_EMOJIS.length === 0) return "🧠";
    const idx = Math.floor(Math.random() * TOPIC_EMOJIS.length);
    return TOPIC_EMOJIS[idx] ?? "🧠";
  }

  private agentShortName(agent: SessionAgent): string {
    return getAgentAdapter(agent).shortName;
  }

  private clipTopicName(name: string): string {
    const oneLine = name.replace(/\s+/g, " ").trim();
    if (oneLine.length <= 128) return oneLine;
    return oneLine.slice(0, 128).trimEnd();
  }

  private truncateText(text: string, maxLen: number): string {
    if (text.length <= maxLen) return text;
    return `${text.slice(0, maxLen - 1)}…`;
  }

  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  private truncateHtmlEscaped(escapedText: string, maxLen: number): string {
    if (maxLen <= 0) return "";
    if (escapedText.length <= maxLen) return escapedText;
    if (maxLen === 1) return "…";

    const budget = maxLen - 1;
    let prefix = escapedText.slice(0, budget);
    const lastAmp = prefix.lastIndexOf("&");
    const lastSemi = prefix.lastIndexOf(";");
    if (lastAmp > lastSemi) prefix = prefix.slice(0, lastAmp);
    return `${prefix}…`;
  }

  private formatTopicHeaderMessage(
    initialPrompt: string,
    sessionId: string,
    lang: UserLanguage,
  ): { text: string; parseMode: "HTML" } {
    const maxChars = this.deps.maxChars;
    const promptLabel = `<b>${t("session.prompt_label", lang)}</b>\n`;
    const sessionBlock = `\n\n<b>${t("session.id_label", lang)}</b>\n<pre>${this.escapeHtml(sessionId)}</pre>`;
    const baseOverhead = promptLabel.length + "<pre></pre>".length + sessionBlock.length;
    const promptBudget = Math.max(0, maxChars - baseOverhead);

    const normalizedPrompt = initialPrompt.trim() || t("session.empty_prompt", lang);
    const escapedPromptFull = this.escapeHtml(normalizedPrompt);
    const clippedEscaped = this.truncateHtmlEscaped(escapedPromptFull, promptBudget);
    let text = `${promptLabel}<pre>${clippedEscaped}</pre>${sessionBlock}`;

    if (text.length > maxChars) {
      const overflow = text.length - maxChars;
      const retryBudget = Math.max(0, promptBudget - overflow);
      const retryClipped = this.truncateHtmlEscaped(escapedPromptFull, retryBudget);
      text = `${promptLabel}<pre>${retryClipped}</pre>${sessionBlock}`;
    }

    if (text.length > maxChars) {
      text = `<b>${t("session.id_label", lang)}</b>\n<pre>${this.escapeHtml(sessionId)}</pre>`;
    }

    return { text, parseMode: "HTML" };
  }
}

/**
 * Factory function to create ForumTopicManager.
 */
export function createForumTopicManager(deps: ForumTopicManagerDeps): ForumTopicManager {
  return new ForumTopicManager(deps);
}
