import { describe, it } from "node:test";
import assert from "node:assert";
import fs from "node:fs";

describe("legacy controller removal", () => {
  it("controller2.ts does not exist", () => {
    assert.ok(!fs.existsSync("src/runtime/controller2.ts"));
  });
});
