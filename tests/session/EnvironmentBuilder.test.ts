import test from "node:test";
import assert from "node:assert/strict";
import { EnvironmentBuilder } from "../../src/runtime/session/EnvironmentBuilder.js";

test("EnvironmentBuilder withBase", async (t) => {
  await t.test("should set base environment variables", () => {
    const builder = new EnvironmentBuilder();
    builder.withBase({ FOO: "bar", BAZ: "qux" });

    const env = builder.getEnv();
    assert.equal(env.FOO, "bar");
    assert.equal(env.BAZ, "qux");
  });

  await t.test("should handle undefined overrides", () => {
    const builder = new EnvironmentBuilder();
    builder.withBase(undefined);

    const env = builder.getEnv();
    assert.deepEqual(env, {});
  });

  await t.test("should merge with existing env", () => {
    const builder = new EnvironmentBuilder();
    builder.withBase({ FOO: "bar" });
    builder.withBase({ BAZ: "qux" });

    const env = builder.getEnv();
    assert.equal(env.FOO, "bar");
    assert.equal(env.BAZ, "qux");
  });
});

test("EnvironmentBuilder withLanguage", async (t) => {
  await t.test("should set language variables for zh", () => {
    const builder = new EnvironmentBuilder();
    builder.withLanguage("zh");

    const env = builder.getEnv();
    assert.equal(env.CHATGPT_PROXY_LANGUAGE, "zh");
    assert.equal(env.TINTIN_USER_LANGUAGE, "zh");
    assert.equal(env.LANG, "zh_CN.UTF-8");
    assert.equal(env.LC_ALL, "zh_CN.UTF-8");
  });

  await t.test("should set language variables for en", () => {
    const builder = new EnvironmentBuilder();
    builder.withLanguage("en");

    const env = builder.getEnv();
    assert.equal(env.CHATGPT_PROXY_LANGUAGE, "en");
    assert.equal(env.TINTIN_USER_LANGUAGE, "en");
    assert.equal(env.LANG, "en_US.UTF-8");
    assert.equal(env.LC_ALL, "en_US.UTF-8");
  });

  await t.test("should not override existing LANG", () => {
    const builder = new EnvironmentBuilder();
    builder.withBase({ LANG: "custom" });
    builder.withLanguage("zh");

    const env = builder.getEnv();
    assert.equal(env.LANG, "custom");
  });
});

test("EnvironmentBuilder set/setAll", async (t) => {
  await t.test("should set a single variable", () => {
    const builder = new EnvironmentBuilder();
    builder.set("KEY", "value");

    assert.equal(builder.getEnv().KEY, "value");
  });

  await t.test("should set multiple variables", () => {
    const builder = new EnvironmentBuilder();
    builder.setAll({ A: "1", B: "2", C: "3" });

    const env = builder.getEnv();
    assert.equal(env.A, "1");
    assert.equal(env.B, "2");
    assert.equal(env.C, "3");
  });
});

test("EnvironmentBuilder build", async (t) => {
  await t.test("should return frozen object", () => {
    const builder = new EnvironmentBuilder();
    builder.set("KEY", "value");

    const env = builder.build();

    // Object.isFrozen should return true
    assert.equal(Object.isFrozen(env), true);
  });

  await t.test("should return a copy", () => {
    const builder = new EnvironmentBuilder();
    builder.set("KEY", "value");

    const env1 = builder.build();
    builder.set("KEY", "changed");
    const env2 = builder.build();

    // First build should not be affected by later changes
    assert.equal(env1.KEY, "value");
    assert.equal(env2.KEY, "changed");
  });
});

test("EnvironmentBuilder clone", async (t) => {
  await t.test("should create independent copy", () => {
    const builder = new EnvironmentBuilder();
    builder.set("KEY", "original");

    const cloned = builder.clone();
    cloned.set("KEY", "cloned");

    assert.equal(builder.getEnv().KEY, "original");
    assert.equal(cloned.getEnv().KEY, "cloned");
  });
});

test("EnvironmentBuilder chaining", async (t) => {
  await t.test("should support method chaining", () => {
    const env = new EnvironmentBuilder()
      .withBase({ BASE: "value" })
      .withLanguage("en")
      .set("CUSTOM", "setting")
      .build();

    assert.equal(env.BASE, "value");
    assert.equal(env.CHATGPT_PROXY_LANGUAGE, "en");
    assert.equal(env.CUSTOM, "setting");
  });
});
