import type { Db } from "../db.js";
import type { RunSummaryCard, DiffStats } from "./types.js";

export interface CardBuilderConfig {
  publicBaseUrl: string;
}

/**
 * Builds summary cards from cloud run data.
 * Single responsibility: card construction and formatting.
 */
export class CardBuilder {
  private readonly baseUrl: string;

  constructor(private readonly config: CardBuilderConfig) {
    // Normalize base URL by removing trailing slash
    this.baseUrl = config.publicBaseUrl.replace(/\/+$/, "");
  }

  /**
   * Build a summary card from a cloud run.
   */
  async buildFromRun(db: Db, runId: string): Promise<RunSummaryCard | null> {
    const run = await db
      .selectFrom("cloud_runs")
      .selectAll()
      .where("id", "=", runId)
      .executeTakeFirst();

    if (!run) return null;

    const session = run.session_id
      ? await db
          .selectFrom("sessions")
          .select(["platform"])
          .where("id", "=", run.session_id)
          .executeTakeFirst()
      : null;

    // Get latest screenshot if available
    const screenshot = await db
      .selectFrom("cloud_run_screenshots")
      .select(["s3_key"])
      .where("run_id", "=", runId)
      .orderBy("created_at", "desc")
      .limit(1)
      .executeTakeFirst();

    const diffStats = run.diff_summary ? this.parseDiffStats(run.diff_summary) : null;

    return {
      runId,
      status: run.status === "finished" ? "completed" : "error",
      title: this.extractTitle(run.prompt),
      prompt: run.prompt,
      diffStats,
      screenshotUrl: this.buildScreenshotUrl(screenshot?.s3_key ?? null),
      viewUrl: this.buildViewUrl(runId),
      vscodeUrl: null, // Filled in separately if available
      initiatorPlatform: session?.platform ?? "unknown",
      finishedAt: run.finished_at ?? run.updated_at,
    };
  }

  /**
   * Parse diff summary string into structured stats.
   * Example: "3 files changed, 45 insertions(+), 12 deletions(-)"
   */
  parseDiffStats(summary: string): DiffStats | null {
    const filesMatch = summary.match(/(\d+)\s+files?\s+changed/);
    const addMatch = summary.match(/(\d+)\s+insertions?\(\+\)/);
    const delMatch = summary.match(/(\d+)\s+deletions?\(-\)/);

    if (!filesMatch) return null;

    return {
      filesChanged: parseInt(filesMatch[1]!, 10),
      additions: addMatch ? parseInt(addMatch[1]!, 10) : 0,
      deletions: delMatch ? parseInt(delMatch[1]!, 10) : 0,
    };
  }

  /**
   * Extract a short title from the prompt.
   */
  extractTitle(prompt: string, maxLength = 50): string {
    const firstLine = prompt.split("\n")[0] ?? prompt;
    const cleaned = firstLine.trim();

    if (cleaned.length <= maxLength) {
      return cleaned;
    }

    return cleaned.slice(0, maxLength - 3) + "...";
  }

  /**
   * Build the view URL for a run.
   */
  buildViewUrl(runId: string): string {
    return `${this.baseUrl}/run/${runId}`;
  }

  /**
   * Build the screenshot URL from an S3 key.
   */
  buildScreenshotUrl(s3Key: string | null): string | null {
    if (!s3Key) return null;
    return `${this.baseUrl}/api/screenshots/${s3Key}`;
  }
}
