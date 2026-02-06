import type { Logger } from "../../log.js";
import type { PlatformSender } from "./types.js";
import type { NotificationTarget, RunSummaryCard } from "../types.js";

interface TelegramBot {
  sendMessage(chatId: string, text: string, options?: object): Promise<unknown>;
  sendPhoto(chatId: string, photo: string, options?: object): Promise<unknown>;
}

export class TelegramSender implements PlatformSender {
  readonly platform = "telegram";

  constructor(
    private readonly bot: TelegramBot | null,
    private readonly logger: Logger,
  ) {}

  async send(target: NotificationTarget, card: RunSummaryCard): Promise<boolean> {
    if (!this.bot) {
      this.logger.debug("[tg-sender] bot not configured, skipping");
      return false;
    }

    const message = this.formatMessage(card);

    try {
      await this.bot.sendMessage(target.userId, message, {
        parse_mode: "Markdown",
        disable_web_page_preview: false,
      });

      if (card.screenshotUrl) {
        await this.bot.sendPhoto(target.userId, card.screenshotUrl, {
          caption: "Preview",
        });
      }

      this.logger.debug(`[tg-sender] sent to ${target.userId}`);
      return true;
    } catch (err) {
      this.logger.warn(`[tg-sender] failed to send to ${target.userId}: ${String(err)}`);
      return false;
    }
  }

  private formatMessage(card: RunSummaryCard): string {
    const statusEmoji = card.status === "completed" ? "✅" : "❌";
    const statusText = card.status === "completed" ? "Build Completed" : "Build Failed";

    const lines = [
      `${statusEmoji} *${statusText}*`,
      "",
      `📝 ${this.escapeMarkdown(card.title)}`,
    ];

    if (card.diffStats) {
      const { filesChanged, additions, deletions } = card.diffStats;
      lines.push(`📊 Changes: ${filesChanged} files (+${additions} / -${deletions})`);
    }

    lines.push(`🖥️ From: ${card.initiatorPlatform}`);
    lines.push("");
    lines.push(`[🔗 View Details](${card.viewUrl})`);

    if (card.vscodeUrl) {
      lines.push(`[💻 Open Editor](${card.vscodeUrl})`);
    }

    return lines.join("\n");
  }

  private escapeMarkdown(text: string): string {
    return text.replace(/[_*[\]()~`>#+=|{}.!-]/g, "\\$&");
  }
}
