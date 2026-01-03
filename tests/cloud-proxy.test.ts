import test from "node:test";
import assert from "node:assert/strict";
import { createProxyToken, verifyProxyToken } from "../src/runtime/cloud/proxy.js";

test("proxy token roundtrip", () => {
  const secret = "super-secret";
  const token = createProxyToken(secret, "ident-123", 60_000);
  const verified = verifyProxyToken(secret, token);
  assert.ok(verified);
  assert.equal(verified?.identityId, "ident-123");
});

test("proxy token rejects bad signature", () => {
  const secret = "super-secret";
  const token = createProxyToken(secret, "ident-123", 60_000);
  const parts = token.split(".");
  const badSig = parts[1] ? `${parts[1]}x` : "bad";
  const bad = `${parts[0]}.${badSig}`;
  const verified = verifyProxyToken(secret, bad);
  assert.equal(verified, null);
});
