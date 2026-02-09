import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("exa_api_keys")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("identity_id", "text", (col) => col.notNull())
    .addColumn("api_key", "text", (col) => col.notNull())
    .addColumn("created_at", "bigint", (col) => col.notNull())
    .addColumn("updated_at", "bigint", (col) => col.notNull())
    .execute();

  await db.schema
    .createIndex("exa_api_keys_identity_uq")
    .on("exa_api_keys")
    .column("identity_id")
    .unique()
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex("exa_api_keys_identity_uq").ifExists().execute();
  await db.schema.dropTable("exa_api_keys").ifExists().execute();
}
