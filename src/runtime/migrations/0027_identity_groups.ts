import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  // 1. Create identity_groups table for cross-platform user linking
  await db.schema
    .createTable("identity_groups")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("github_user_id", "text", (col) => col.notNull().unique())
    .addColumn("github_login", "text")
    .addColumn("created_at", "integer", (col) => col.notNull())
    .addColumn("updated_at", "integer", (col) => col.notNull())
    .execute();

  // 2. Add group_id to identities table for linking
  await db.schema
    .alterTable("identities")
    .addColumn("group_id", "text")
    .execute();

  // 3. Create index for faster group lookups
  await db.schema
    .createIndex("idx_identities_group_id")
    .on("identities")
    .columns(["group_id"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex("idx_identities_group_id").execute();
  await db.schema.alterTable("identities").dropColumn("group_id").execute();
  await db.schema.dropTable("identity_groups").execute();
}
