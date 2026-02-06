import type { Logger } from "../log.js";
import type { Db } from "../db.js";
import type { PlatformSender } from "./senders/types.js";
import type { NotificationTarget } from "./types.js";
import { CardBuilder, type CardBuilderConfig } from "./CardBuilder.js";
import { GroupStore } from "./GroupStore.js";

export interface RunNotificationServiceOptions {
  groupStore: GroupStore;
  cardBuilder: CardBuilder | null;
  senders: PlatformSender[];
  logger: Logger;
}

/**
 * Orchestrates run completion notifications across platforms.
 */
export class RunNotificationService {
  private readonly senders: Map<string, PlatformSender>;
  private readonly groupStore: GroupStore;
  private readonly cardBuilder: CardBuilder | null;
  private readonly logger: Logger;

  constructor(opts: RunNotificationServiceOptions) {
    this.groupStore = opts.groupStore;
    this.cardBuilder = opts.cardBuilder;
    this.senders = new Map(opts.senders.map((s) => [s.platform, s]));
    this.logger = opts.logger;
  }

  /**
   * Create a service instance with database access.
   */
  static create(opts: {
    db: Db;
    config: CardBuilderConfig;
    senders: PlatformSender[];
    logger: Logger;
  }): RunNotificationService {
    return new RunNotificationService({
      groupStore: new GroupStore(opts.db),
      cardBuilder: new CardBuilder(opts.config),
      senders: opts.senders,
      logger: opts.logger,
    });
  }

  /**
   * Notify all related identities about a completed run.
   * @param runId - The cloud run ID
   * @param initiatorIdentityId - The identity that started the run
   * @param db - Database connection for building card
   */
  async notifyRunCompleted(
    runId: string,
    initiatorIdentityId: string,
    db?: Db,
  ): Promise<void> {
    // 1. Get initiator's group
    const groupId = await this.groupStore.getGroupIdForIdentity(initiatorIdentityId);
    if (!groupId) {
      this.logger.debug(`[notify] identity ${initiatorIdentityId} has no group, skipping`);
      return;
    }

    // 2. Find other identities in the same group
    const targets = await this.groupStore.listOtherIdentitiesInGroup(
      groupId,
      initiatorIdentityId,
    );

    if (targets.length === 0) {
      this.logger.debug(`[notify] no other identities in group ${groupId}`);
      return;
    }

    // 3. Build summary card
    if (!this.cardBuilder || !db) {
      this.logger.debug("[notify] cardBuilder or db not available, skipping card build");
      return;
    }

    const card = await this.cardBuilder.buildFromRun(db, runId);
    if (!card) {
      this.logger.warn(`[notify] failed to build card for run ${runId}`);
      return;
    }

    // 4. Send to all targets
    this.logger.info(
      `[notify] sending to ${targets.length} targets for run ${runId}`,
    );

    const results = await Promise.allSettled(
      targets.map((target) => this.sendToTarget(target, card)),
    );

    // Log results
    const succeeded = results.filter((r) => r.status === "fulfilled" && r.value).length;
    const failed = results.length - succeeded;
    this.logger.debug(`[notify] sent ${succeeded}/${targets.length} (${failed} failed)`);
  }

  private async sendToTarget(
    target: NotificationTarget,
    card: Parameters<PlatformSender["send"]>[1],
  ): Promise<boolean> {
    const sender = this.senders.get(target.platform);
    if (!sender) {
      this.logger.debug(`[notify] no sender for platform ${target.platform}`);
      return false;
    }

    try {
      return await sender.send(target, card);
    } catch (err) {
      this.logger.warn(
        `[notify] sender error for ${target.platform}/${target.identityId}: ${String(err)}`,
      );
      return false;
    }
  }
}
