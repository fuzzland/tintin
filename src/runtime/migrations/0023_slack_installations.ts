import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("slack_installations")
    .addColumn("id", "varchar(36)", (c) => c.primaryKey())
    .addColumn("team_id", "varchar(128)")
    .addColumn("enterprise_id", "varchar(128)")
    .addColumn("is_enterprise_install", "integer", (c) => c.notNull())
    .addColumn("bot_token", "text")
    .addColumn("bot_refresh_token", "text")
    .addColumn("bot_token_expires_at", "bigint")
    .addColumn("installed_by_user_id", "varchar(128)")
    .addColumn("data_json", "text", (c) => c.notNull())
    .addColumn("created_at", "bigint", (c) => c.notNull())
    .addColumn("updated_at", "bigint", (c) => c.notNull())
    .execute();

  await db.schema.createIndex("slack_installations_team_uq").on("slack_installations").column("team_id").unique().execute();
  await db.schema
    .createIndex("slack_installations_enterprise_uq")
    .on("slack_installations")
    .column("enterprise_id")
    .unique()
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex("slack_installations_enterprise_uq").ifExists().execute();
  await db.schema.dropIndex("slack_installations_team_uq").ifExists().execute();
  await db.schema.dropTable("slack_installations").ifExists().execute();
}
