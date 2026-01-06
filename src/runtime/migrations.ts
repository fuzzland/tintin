import { Migrator } from "kysely";
import type { Db } from "./db.js";
import type { Logger } from "./log.js";
import * as init0001 from "./migrations/0001_init.js";
import * as pending0002 from "./migrations/0002_pending_messages.js";
import * as spaceEmoji0003 from "./migrations/0003_space_emoji.js";
import * as sessionAgent0004 from "./migrations/0004_session_agent.js";
import * as cloud0005 from "./migrations/0005_cloud_mode.js";
import * as cloudKeepalive0006 from "./migrations/0006_cloud_keepalive.js";
import * as cloudUi0007 from "./migrations/0007_cloud_ui.js";
import * as setupSpecSnapshot0008 from "./migrations/0008_setup_spec_snapshot.js";
import * as browserbaseSession0010 from "./migrations/0010_browserbase_session.js";
import * as gitCommitterFix0011 from "./migrations/0011_git_committer_fix.js";
import * as hyperbrowserSession0012 from "./migrations/0012_hyperbrowser_session.js";
import * as identityVerbosity0013 from "./migrations/0013_identity_message_verbosity.js";
import * as identityBranchRule0014 from "./migrations/0014_identity_branch_name_rule.js";
import * as cloudWorkspaces0015 from "./migrations/0015_cloud_workspaces.js";

const provider = {
  async getMigrations() {
    return {
      "0001_init": init0001,
      "0002_pending_messages": pending0002,
      "0003_space_emoji": spaceEmoji0003,
      "0004_session_agent": sessionAgent0004,
      "0005_cloud_mode": cloud0005,
      "0006_cloud_keepalive": cloudKeepalive0006,
      "0007_cloud_ui": cloudUi0007,
      "0008_setup_spec_snapshot": setupSpecSnapshot0008,
      "0010_browserbase_session": browserbaseSession0010,
      "0011_git_committer_fix": gitCommitterFix0011,
      "0012_hyperbrowser_session": hyperbrowserSession0012,
      "0013_identity_message_verbosity": identityVerbosity0013,
      "0014_identity_branch_name_rule": identityBranchRule0014,
      "0015_cloud_workspaces": cloudWorkspaces0015,
    };
  },
};

export async function runMigrations(db: Db, logger: Logger) {
  const migrator = new Migrator({ db, provider });
  const { error, results } = await migrator.migrateToLatest();

  for (const r of results ?? []) {
    const suffix = r.status === "Success" ? "ok" : r.status === "Error" ? "error" : "skipped";
    logger.info(`migration ${r.migrationName}: ${suffix}`);
  }

  if (error) throw error;
}
