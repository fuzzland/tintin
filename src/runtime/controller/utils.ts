import type { TelegramMessageEntity } from "../platform/telegram.js";
import { redactText } from "../redact.js";

export function telegramChatIdMatchesAllowlist(chatId: string, allowIds: string[]): boolean {
  if (allowIds.length === 0) return true;
  const c = chatId.trim();
  const candidates = new Set<string>([c]);

  if (c.startsWith("-100") && c.length > 4) candidates.add(c.slice(4));
  if (c.startsWith("-") && c.length > 1) candidates.add(c.slice(1));

  for (const raw of allowIds) {
    const a = String(raw).trim();
    if (candidates.has(a)) return true;
  }
  return false;
}

export function safeSnippet(text: string, maxLen = 200): string {
  const redacted = redactText(text);
  const oneLine = redacted.replace(/\s+/g, " ").trim();
  if (oneLine.length <= maxLen) return oneLine;
  return `${oneLine.slice(0, maxLen)}…`;
}

export function truncateWithEllipsis(text: string, maxLen: number): string {
  if (maxLen <= 0) return "";
  if (text.length <= maxLen) return text;
  if (maxLen === 1) return text.slice(0, 1);
  return `${text.slice(0, maxLen - 1)}…`;
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function truncateHtmlEscapedWithEllipsis(escapedText: string, maxLen: number): string {
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

export function buildTelegramCustomEmojiEntity(text: string, emoji: string, customEmojiId: string): TelegramMessageEntity | null {
  const offset = text.lastIndexOf(emoji);
  if (offset < 0) return null;
  return { type: "custom_emoji", offset, length: emoji.length, custom_emoji_id: customEmojiId };
}

const TOPIC_EMOJIS = [
  "🧠",
  "🛠️",
  "🚀",
  "🧩",
  "🧪",
  "🧰",
  "📌",
  "📎",
  "📝",
  "🔎",
  "🧭",
  "⚙️",
  "🧵",
  "🗂️",
  "🗒️",
  "📦",
  "🛰️",
  "🧯",
  "🧱",
  "🔧",
  "🔨",
  "🪄",
  "🧿",
  "🧷",
  "🧬",
  "📡",
  "🧑‍💻",
  "🕵️",
  "🧾",
  "🗳️",
];

export function pickTopicEmoji(): string {
  if (TOPIC_EMOJIS.length === 0) return "🧠";
  const idx = Math.floor(Math.random() * TOPIC_EMOJIS.length);
  return TOPIC_EMOJIS[idx] ?? "🧠";
}

export function clipForumTopicName(name: string): string {
  const oneLine = name.replace(/\s+/g, " ").trim();
  if (oneLine.length <= 128) return oneLine;
  return oneLine.slice(0, 128).trimEnd();
}
