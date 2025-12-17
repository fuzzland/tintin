import { Migrator } from "kysely";
import type { Db } from "./db.js";
import type { Logger } from "./log.js";
import * as init0001 from "./migrations/0001_init.js";
import * as pending0002 from "./migrations/0002_pending_messages.js";
import * as spaceEmoji0003 from "./migrations/0003_space_emoji.js";
import * as sessionAgent0004 from "./migrations/0004_session_agent.js";

const provider = {
  async getMigrations() {
    return {
      "0001_init": init0001,
      "0002_pending_messages": pending0002,
      "0003_space_emoji": spaceEmoji0003,
      "0004_session_agent": sessionAgent0004,
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
