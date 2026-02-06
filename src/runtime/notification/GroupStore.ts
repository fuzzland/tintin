import crypto from "node:crypto";
import type { Db } from "../db.js";
import type { NotificationTarget } from "./types.js";

/**
 * Data access for identity groups.
 * Single responsibility: group-related queries.
 */
export class GroupStore {
  constructor(private readonly db: Db) {}

  async getGroupIdForIdentity(identityId: string): Promise<string | null> {
    const row = await this.db
      .selectFrom("identities")
      .select("group_id")
      .where("id", "=", identityId)
      .executeTakeFirst();

    return row?.group_id ?? null;
  }

  async listOtherIdentitiesInGroup(
    groupId: string,
    excludeIdentityId: string,
  ): Promise<NotificationTarget[]> {
    const rows = await this.db
      .selectFrom("identities")
      .select(["id", "platform", "user_id", "workspace_id"])
      .where("group_id", "=", groupId)
      .where("id", "!=", excludeIdentityId)
      .execute();

    return rows.map((row) => ({
      identityId: row.id,
      platform: row.platform as NotificationTarget["platform"],
      userId: row.user_id,
      workspaceId: row.workspace_id,
    }));
  }

  async getOrCreateGroup(
    githubUserId: string,
    githubLogin: string | null,
  ): Promise<string> {
    const existing = await this.db
      .selectFrom("identity_groups")
      .select("id")
      .where("github_user_id", "=", githubUserId)
      .executeTakeFirst();

    if (existing) {
      return existing.id;
    }

    const now = Date.now();
    const id = crypto.randomUUID();

    await this.db
      .insertInto("identity_groups")
      .values({
        id,
        github_user_id: githubUserId,
        github_login: githubLogin,
        created_at: now,
        updated_at: now,
      })
      .execute();

    return id;
  }

  async linkIdentityToGroup(identityId: string, groupId: string): Promise<void> {
    await this.db
      .updateTable("identities")
      .set({ group_id: groupId, updated_at: Date.now() })
      .where("id", "=", identityId)
      .execute();
  }
}
