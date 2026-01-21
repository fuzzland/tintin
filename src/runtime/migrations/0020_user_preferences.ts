import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("user_preferences")
    .addColumn("id", "varchar(36)", (c) => c.primaryKey())
    .addColumn("platform", "varchar(32)", (c) => c.notNull())
    .addColumn("user_id", "varchar(64)", (c) => c.notNull())
    .addColumn("language", "varchar(8)", (c) => c.notNull().defaultTo("en"))
    .addColumn("created_at", "bigint", (c) => c.notNull())
    .addColumn("updated_at", "bigint", (c) => c.notNull())
    .execute();

  await db.schema
    .createIndex("user_preferences_platform_user_uq")
    .unique()
    .on("user_preferences")
    .columns(["platform", "user_id"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex("user_preferences_platform_user_uq").ifExists().execute();
  await db.schema.dropTable("user_preferences").ifExists().execute();
}
