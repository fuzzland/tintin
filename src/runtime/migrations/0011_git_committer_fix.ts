import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("identities").addColumn("git_user_name", "varchar(256)").execute();
  await db.schema.alterTable("identities").addColumn("git_user_email", "varchar(256)").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("identities").dropColumn("git_user_email").execute();
  await db.schema.alterTable("identities").dropColumn("git_user_name").execute();
}
