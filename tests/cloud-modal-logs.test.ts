import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { Logger } from "../src/runtime/log.js";
import { findRemoteJsonlFiles, RemoteLogSync } from "../src/runtime/cloud/modalLogs.js";

type ExecResult = {
  stdout: { readText: () => Promise<string> };
  stderr: { readText: () => Promise<string> };
  wait: () => Promise<number>;
};

function makeLogger(): Logger {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

function makeProc(stdout: string, stderr = "", exitCode = 0): ExecResult {
  return {
    stdout: { readText: async () => stdout },
    stderr: { readText: async () => stderr },
    wait: async () => exitCode,
  };
}

test("findRemoteJsonlFiles finds matching JSONL logs", async () => {
  const files = ["/root/sessions/run1/foo-abc.jsonl"];
  const sandbox: any = {
    exec: async (_args: string[]) => makeProc(`${files.join("\n")}\n`),
  };

  const result = await findRemoteJsonlFiles({
    sandbox,
    sessionsRoot: "/root/sessions",
    sessionId: "abc",
    timeoutMs: 100,
    pollMs: 10,
  });

  assert.deepEqual(result, files);
});

test("RemoteLogSync mirrors remote JSONL to local file without duplication", async () => {
  const remotePath = "/logs/run.jsonl";
  const remoteContent = "line1\nline2\n";
  const bytes = Buffer.from(remoteContent);

  const sandbox: any = {
    exec: async (args: string[]) => {
      const cmd = args[2] ?? "";
      const match = cmd.match(/tail -c \+(\d+) ("[^"]+")/);
      if (!match || !match[1] || !match[2]) return makeProc("");
      const start = Number(match[1]);
      const pathArg = JSON.parse(match[2]);
      if (pathArg !== remotePath) return makeProc("");
      const slice = bytes.slice(Math.max(0, start - 1));
      return makeProc(slice.toString("utf8"));
    },
  };

  const dir = await mkdtemp(path.join(os.tmpdir(), "tintin-log-"));
  const localPath = path.join(dir, "run.jsonl");
  await writeFile(localPath, "", "utf8");

  const syncer = new RemoteLogSync(sandbox, remotePath, localPath, makeLogger(), 5, 5000);
  await syncer.drain(2);
  const first = await readFile(localPath, "utf8");
  assert.equal(first, remoteContent);

  await syncer.drain(2);
  const second = await readFile(localPath, "utf8");
  assert.equal(second, remoteContent);

  await rm(dir, { recursive: true, force: true });
});
