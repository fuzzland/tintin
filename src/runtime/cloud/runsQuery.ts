import type { Db } from "../db.js";

export interface RunSummary {
  id: string;
  status: string;
  prompt: string;
  platform: string;
  diffSummary: string | null;
  createdAt: number;
}

/**
 * List recent cloud runs for all identities in a group.
 * Used for cross-platform /runs command.
 */
export async function listRunsForGroup(
  db: Db,
  groupId: string,
  limit = 5,
): Promise<RunSummary[]> {
  // Get all identity IDs in the group
  const identities = await db
    .selectFrom("identities")
    .select("id")
    .where("group_id", "=", groupId)
    .execute();

  if (identities.length === 0) return [];

  const identityIds = identities.map((i) => i.id);

  // Query runs for all identities in the group
  const runs = await db
    .selectFrom("cloud_runs")
    .innerJoin("sessions", "sessions.id", "cloud_runs.session_id")
    .select([
      "cloud_runs.id",
      "cloud_runs.status",
      "cloud_runs.prompt",
      "cloud_runs.diff_summary",
      "cloud_runs.created_at",
      "sessions.platform",
    ])
    .where("cloud_runs.identity_id", "in", identityIds)
    .orderBy("cloud_runs.created_at", "desc")
    .limit(limit)
    .execute();

  return runs.map((r) => ({
    id: r.id,
    status: r.status,
    prompt: r.prompt,
    platform: r.platform,
    diffSummary: r.diff_summary,
    createdAt: r.created_at,
  }));
}

/**
 * Format time ago string for display.
 */
export function formatTimeAgo(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;

  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return "just now";
}
