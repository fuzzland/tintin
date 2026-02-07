import { describe, it } from "node:test";
import assert from "node:assert";
import { parseSessionsArgs, parseSettingsArgs } from "../../src/runtime/shared/commandParser.js";

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
});
