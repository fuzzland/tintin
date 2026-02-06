import type { Logger } from "../../log.js";
import type { WebSocketManager } from "../../websocket/manager.js";
import type { PlatformSender } from "./types.js";
import type { NotificationTarget, RunSummaryCard } from "../types.js";

export class WebSocketSender implements PlatformSender {
  readonly platform = "websocket";

  constructor(
    private readonly wsManager: WebSocketManager | null,
    private readonly logger: Logger,
  ) {}

  async send(target: NotificationTarget, card: RunSummaryCard): Promise<boolean> {
    if (!this.wsManager) {
      this.logger.debug("[ws-sender] manager not configured, skipping");
      return false;
    }

    try {
      const sent = this.wsManager.sendToIdentity(target.identityId, {
        type: "run_completed_notification",
        runId: card.runId,
        status: card.status,
        title: card.title,
        diffStats: card.diffStats,
        screenshotUrl: card.screenshotUrl,
        viewUrl: card.viewUrl,
        vscodeUrl: card.vscodeUrl,
        initiatorPlatform: card.initiatorPlatform,
        finishedAt: card.finishedAt,
      });

      if (sent > 0) {
        this.logger.debug(`[ws-sender] sent to ${target.identityId} (${sent} connections)`);
        return true;
      }

      this.logger.debug(`[ws-sender] no active connections for ${target.identityId}`);
      return false;
    } catch (err) {
      this.logger.warn(`[ws-sender] failed to send to ${target.identityId}: ${String(err)}`);
      return false;
    }
  }
}
