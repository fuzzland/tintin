import { describe, it } from "node:test";
import assert from "node:assert";
import { parseSessionsArgs, parseSettingsArgs } from "../../src/runtime/shared/commandParser.js";
import { normalizeCloudText, parseCloudCommand, PLAYGROUND_REPO_ID } from "../../src/runtime/shared/commands.js";

describe("shared commandParser", () => {
  it("parses sessions args with page and status", () => {
    const result = parseSessionsArgs("page=2 running");
    assert.strictEqual(result.page, 2);
    assert.deepStrictEqual(result.statuses, ["running"]);
  });

  it("parses settings set/unset", () => {
    const setResult = parseSettingsArgs("set theme dark");
    assert.deepStrictEqual(setResult, { kind: "set", target: "theme", value: "dark" });

    const unsetResult = parseSettingsArgs("unset theme");
    assert.deepStrictEqual(unsetResult, { kind: "unset", target: "theme" });
  });

  it("normalizes slack markup and @bot suffix", () => {
    assert.strictEqual(normalizeCloudText("</run|/run>"), "run");
    assert.strictEqual(normalizeCloudText("/run@tintin hello"), "run hello");
  });

  it("parses cloud commands", () => {
    const cmd = parseCloudCommand("/repos 2");
    assert.deepStrictEqual(cmd, { kind: "repos", provider: undefined, search: "2" });
  });

  it("keeps playground repo id constant", () => {
    assert.strictEqual(PLAYGROUND_REPO_ID, "__playground__");
  });

  it("parses mcp set shorthand in settings args", () => {
    const result = parseSettingsArgs("mcp set search http://localhost");
    assert.deepStrictEqual(result, { kind: "set", target: "mcp.search", value: "http://localhost" });
  });

  it("parses active session filter", () => {
    const result = parseSessionsArgs("active");
    assert.deepStrictEqual(result, { page: 1, statuses: ["starting", "running"] });
  });
});
