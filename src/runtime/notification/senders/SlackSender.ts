import type { Logger } from "../../log.js";
import type { PlatformSender } from "./types.js";
import type { NotificationTarget, RunSummaryCard } from "../types.js";

interface SlackClient {
  postMessage(channel: string, blocks: object[], text: string): Promise<unknown>;
}

export class SlackSender implements PlatformSender {
  readonly platform = "slack";

  constructor(
    private readonly client: SlackClient | null,
    private readonly logger: Logger,
  ) {}

  async send(target: NotificationTarget, card: RunSummaryCard): Promise<boolean> {
    if (!this.client) {
      this.logger.debug("[slack-sender] client not configured, skipping");
      return false;
    }

    const blocks = this.buildBlocks(card);
    const fallbackText = `${card.status === "completed" ? "✅" : "❌"} ${card.title}`;

    try {
      await this.client.postMessage(target.userId, blocks, fallbackText);
      this.logger.debug(`[slack-sender] sent to ${target.userId}`);
      return true;
    } catch (err) {
      this.logger.warn(`[slack-sender] failed to send to ${target.userId}: ${String(err)}`);
      return false;
    }
  }

  private buildBlocks(card: RunSummaryCard): object[] {
    const statusEmoji = card.status === "completed" ? "✅" : "❌";
    const statusText = card.status === "completed" ? "Build Completed" : "Build Failed";

    const blocks: object[] = [
      {
        type: "header",
        text: { type: "plain_text", text: `${statusEmoji} ${statusText}`, emoji: true },
      },
      {
        type: "section",
        text: { type: "mrkdwn", text: `*${this.escapeSlackText(card.title)}*` },
      },
    ];

    const contextElements: object[] = [];

    if (card.diffStats) {
      const { filesChanged, additions, deletions } = card.diffStats;
      contextElements.push({ type: "mrkdwn", text: `📊 ${filesChanged} files changed` });
      contextElements.push({ type: "mrkdwn", text: `+${additions} / -${deletions}` });
    }

    contextElements.push({ type: "mrkdwn", text: `From: ${card.initiatorPlatform}` });

    if (contextElements.length > 0) {
      blocks.push({
        type: "context",
        elements: contextElements,
      });
    }

    if (card.screenshotUrl) {
      blocks.push({
        type: "image",
        image_url: card.screenshotUrl,
        alt_text: "Preview",
      });
    }

    const actionElements: object[] = [
      {
        type: "button",
        text: { type: "plain_text", text: "🔗 View Details", emoji: true },
        url: card.viewUrl,
        action_id: "view_details",
      },
    ];

    if (card.vscodeUrl) {
      actionElements.push({
        type: "button",
        text: { type: "plain_text", text: "💻 Open Editor", emoji: true },
        url: card.vscodeUrl,
        action_id: "open_editor",
      });
    }

    blocks.push({
      type: "actions",
      elements: actionElements,
    });

    return blocks;
  }

  private escapeSlackText(text: string): string {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }
}
