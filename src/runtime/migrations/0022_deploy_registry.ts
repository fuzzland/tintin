import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("code_registry")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("idx", "integer", (col) => col.notNull())
    .addColumn("identity_id", "text", (col) => col.notNull())
    .addColumn("directory", "text", (col) => col.notNull())
    .addColumn("summary", "text", (col) => col.notNull())
    .addColumn("created_at", "integer", (col) => col.notNull())
    .addColumn("updated_at", "integer", (col) => col.notNull())
    .execute();
  await db.schema.createIndex("code_registry_idx_uq").unique().on("code_registry").column("idx").execute();
  await db.schema.createIndex("code_registry_identity_idx").on("code_registry").column("identity_id").execute();

  await db.schema
    .createTable("site_registry")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("idx", "integer", (col) => col.notNull())
    .addColumn("identity_id", "text", (col) => col.notNull())
    .addColumn("port", "integer", (col) => col.notNull())
    .addColumn("path", "text", (col) => col.notNull().defaultTo(""))
    .addColumn("summary", "text", (col) => col.notNull())
    .addColumn("created_at", "integer", (col) => col.notNull())
    .addColumn("updated_at", "integer", (col) => col.notNull())
    .execute();
  await db.schema.createIndex("site_registry_idx_uq").unique().on("site_registry").column("idx").execute();
  await db.schema.createIndex("site_registry_identity_idx").on("site_registry").column("identity_id").execute();

  await db.schema
    .createTable("static_deploys")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("idx", "integer", (col) => col.notNull())
    .addColumn("identity_id", "text", (col) => col.notNull())
    .addColumn("session_id", "text", (col) => col.notNull())
    .addColumn("app_name", "text", (col) => col.notNull())
    .addColumn("summary", "text", (col) => col.notNull())
    .addColumn("root_path", "text", (col) => col.notNull())
    .addColumn("version_host", "text", (col) => col.notNull())
    .addColumn("stable_host", "text", (col) => col.notNull())
    .addColumn("is_active", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("created_at", "integer", (col) => col.notNull())
    .addColumn("updated_at", "integer", (col) => col.notNull())
    .execute();
  await db.schema.createIndex("static_deploys_idx_uq").unique().on("static_deploys").column("idx").execute();
  await db.schema.createIndex("static_deploys_identity_idx").on("static_deploys").column("identity_id").execute();
  await db.schema.createIndex("static_deploys_session_idx").on("static_deploys").column("session_id").execute();

  await db.schema
    .createTable("dynamic_deploys")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("idx", "integer", (col) => col.notNull())
    .addColumn("identity_id", "text", (col) => col.notNull())
    .addColumn("session_id", "text", (col) => col.notNull())
    .addColumn("app_name", "text", (col) => col.notNull())
    .addColumn("summary", "text", (col) => col.notNull())
    .addColumn("provider", "text", (col) => col.notNull())
    .addColumn("image_ref", "text", (col) => col.notNull())
    .addColumn("workspace_id", "text", (col) => col.notNull())
    .addColumn("port", "integer", (col) => col.notNull())
    .addColumn("startup", "text", (col) => col.notNull())
    .addColumn("setup_json", "text", (col) => col.notNull().defaultTo("[]"))
    .addColumn("ignore_json", "text", (col) => col.notNull().defaultTo("[]"))
    .addColumn("snapshot_id", "text")
    .addColumn("archive_path", "text", (col) => col.notNull())
    .addColumn("url", "text", (col) => col.notNull().defaultTo(""))
    .addColumn("log_path", "text", (col) => col.notNull().defaultTo(""))
    .addColumn("status", "text", (col) => col.notNull().defaultTo("pending"))
    .addColumn("created_at", "integer", (col) => col.notNull())
    .addColumn("updated_at", "integer", (col) => col.notNull())
    .execute();
  await db.schema.createIndex("dynamic_deploys_idx_uq").unique().on("dynamic_deploys").column("idx").execute();
  await db.schema.createIndex("dynamic_deploys_identity_idx").on("dynamic_deploys").column("identity_id").execute();
  await db.schema.createIndex("dynamic_deploys_session_idx").on("dynamic_deploys").column("session_id").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex("dynamic_deploys_session_idx").ifExists().execute();
  await db.schema.dropIndex("dynamic_deploys_identity_idx").ifExists().execute();
  await db.schema.dropIndex("dynamic_deploys_idx_uq").ifExists().execute();
  await db.schema.dropTable("dynamic_deploys").ifExists().execute();

  await db.schema.dropIndex("static_deploys_session_idx").ifExists().execute();
  await db.schema.dropIndex("static_deploys_identity_idx").ifExists().execute();
  await db.schema.dropIndex("static_deploys_idx_uq").ifExists().execute();
  await db.schema.dropTable("static_deploys").ifExists().execute();

  await db.schema.dropIndex("site_registry_identity_idx").ifExists().execute();
  await db.schema.dropIndex("site_registry_idx_uq").ifExists().execute();
  await db.schema.dropTable("site_registry").ifExists().execute();

  await db.schema.dropIndex("code_registry_identity_idx").ifExists().execute();
  await db.schema.dropIndex("code_registry_idx_uq").ifExists().execute();
  await db.schema.dropTable("code_registry").ifExists().execute();
}
