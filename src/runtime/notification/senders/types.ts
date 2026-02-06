import type { NotificationTarget, RunSummaryCard } from "../types.js";

/**
 * Platform-specific sender interface.
 * Implements Strategy pattern for extensibility.
 */
export interface PlatformSender {
  readonly platform: string;

  /**
   * Send notification to a specific target.
   * @returns true if sent successfully, false otherwise
   */
  send(target: NotificationTarget, card: RunSummaryCard): Promise<boolean>;
}
