import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert";
import { Kysely, SqliteDialect } from "kysely";
import Database from "better-sqlite3";
import type { DatabaseSchema } from "../../src/runtime/db.js";
import { GroupStore } from "../../src/runtime/notification/GroupStore.js";

describe("GroupStore", () => {
  let db: Kysely<DatabaseSchema>;
  let store: GroupStore;

  beforeEach(async () => {
    const sqlite = new Database(":memory:");
    db = new Kysely<DatabaseSchema>({ dialect: new SqliteDialect({ database: sqlite }) });

    // Create tables
    await db.schema
      .createTable("identity_groups")
      .addColumn("id", "text", (col) => col.primaryKey())
      .addColumn("github_user_id", "text", (col) => col.notNull().unique())
      .addColumn("github_login", "text")
      .addColumn("created_at", "integer", (col) => col.notNull())
      .addColumn("updated_at", "integer", (col) => col.notNull())
      .execute();

    await db.schema
      .createTable("identities")
      .addColumn("id", "text", (col) => col.primaryKey())
      .addColumn("platform", "text", (col) => col.notNull())
      .addColumn("workspace_id", "text")
      .addColumn("user_id", "text", (col) => col.notNull())
      .addColumn("group_id", "text")
      .addColumn("created_at", "integer", (col) => col.notNull())
      .addColumn("updated_at", "integer", (col) => col.notNull())
      .execute();

    store = new GroupStore(db);
  });

  after(async () => {
    await db?.destroy();
  });

  describe("getOrCreateGroup", () => {
    it("should create new group if not exists", async () => {
      const groupId = await store.getOrCreateGroup("12345", "testuser");
      assert.ok(groupId);

      const group = await db
        .selectFrom("identity_groups")
        .where("id", "=", groupId)
        .selectAll()
        .executeTakeFirst();

      assert.strictEqual(group?.github_user_id, "12345");
      assert.strictEqual(group?.github_login, "testuser");
    });

    it("should return existing group if exists", async () => {
      const groupId1 = await store.getOrCreateGroup("12345", "testuser");
      const groupId2 = await store.getOrCreateGroup("12345", "testuser");
      assert.strictEqual(groupId1, groupId2);
    });
  });

  describe("linkIdentityToGroup", () => {
    it("should update identity with group_id", async () => {
      const groupId = await store.getOrCreateGroup("12345", "testuser");

      await db.insertInto("identities").values({
        id: "id-tg",
        platform: "telegram",
        user_id: "tg123",
        workspace_id: null,
        group_id: null,
        created_at: Date.now(),
        updated_at: Date.now(),
      }).execute();

      await store.linkIdentityToGroup("id-tg", groupId);

      const identity = await db
        .selectFrom("identities")
        .where("id", "=", "id-tg")
        .selectAll()
        .executeTakeFirst();

      assert.strictEqual(identity?.group_id, groupId);
    });
  });

  describe("getGroupIdForIdentity", () => {
    it("should return group_id if identity has one", async () => {
      const groupId = await store.getOrCreateGroup("12345", "testuser");

      await db.insertInto("identities").values({
        id: "id-tg",
        platform: "telegram",
        user_id: "tg123",
        workspace_id: null,
        group_id: groupId,
        created_at: Date.now(),
        updated_at: Date.now(),
      }).execute();

      const result = await store.getGroupIdForIdentity("id-tg");
      assert.strictEqual(result, groupId);
    });

    it("should return null if identity has no group", async () => {
      await db.insertInto("identities").values({
        id: "id-tg",
        platform: "telegram",
        user_id: "tg123",
        workspace_id: null,
        group_id: null,
        created_at: Date.now(),
        updated_at: Date.now(),
      }).execute();

      const result = await store.getGroupIdForIdentity("id-tg");
      assert.strictEqual(result, null);
    });
  });

  describe("listOtherIdentitiesInGroup", () => {
    it("should return other identities in same group", async () => {
      const groupId = await store.getOrCreateGroup("12345", "testuser");

      // Insert two identities in same group
      await db.insertInto("identities").values({
        id: "id-tg",
        platform: "telegram",
        user_id: "tg123",
        workspace_id: null,
        group_id: groupId,
        created_at: Date.now(),
        updated_at: Date.now(),
      }).execute();

      await db.insertInto("identities").values({
        id: "id-web",
        platform: "websocket",
        user_id: "web456",
        workspace_id: null,
        group_id: groupId,
        created_at: Date.now(),
        updated_at: Date.now(),
      }).execute();

      const targets = await store.listOtherIdentitiesInGroup(groupId, "id-tg");

      assert.strictEqual(targets.length, 1);
      assert.strictEqual(targets[0]?.identityId, "id-web");
      assert.strictEqual(targets[0]?.platform, "websocket");
    });

    it("should return empty array if no other identities", async () => {
      const groupId = await store.getOrCreateGroup("12345", "testuser");

      await db.insertInto("identities").values({
        id: "id-tg",
        platform: "telegram",
        user_id: "tg123",
        workspace_id: null,
        group_id: groupId,
        created_at: Date.now(),
        updated_at: Date.now(),
      }).execute();

      const targets = await store.listOtherIdentitiesInGroup(groupId, "id-tg");
      assert.strictEqual(targets.length, 0);
    });

    it("should return multiple identities across platforms", async () => {
      const groupId = await store.getOrCreateGroup("12345", "testuser");

      // Insert three identities in same group
      await db.insertInto("identities").values({
        id: "id-tg",
        platform: "telegram",
        user_id: "tg123",
        workspace_id: null,
        group_id: groupId,
        created_at: Date.now(),
        updated_at: Date.now(),
      }).execute();

      await db.insertInto("identities").values({
        id: "id-slack",
        platform: "slack",
        user_id: "slack456",
        workspace_id: "W123",
        group_id: groupId,
        created_at: Date.now(),
        updated_at: Date.now(),
      }).execute();

      await db.insertInto("identities").values({
        id: "id-web",
        platform: "websocket",
        user_id: "web789",
        workspace_id: null,
        group_id: groupId,
        created_at: Date.now(),
        updated_at: Date.now(),
      }).execute();

      const targets = await store.listOtherIdentitiesInGroup(groupId, "id-tg");

      assert.strictEqual(targets.length, 2);
      const platforms = targets.map((t: { platform: string }) => t.platform).sort();
      assert.deepStrictEqual(platforms, ["slack", "websocket"]);
    });
  });
});
