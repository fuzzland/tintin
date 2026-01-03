import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { FileType } from "e2b";
import type { Logger } from "../src/runtime/log.js";
import { findRemoteJsonlFiles, RemoteLogSync } from "../src/runtime/cloud/e2bLogs.js";

function makeLogger(): Logger {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

test("findRemoteJsonlFiles finds matching JSONL logs", async () => {
  const tree: Record<string, Array<{ path: string; type: FileType }>> = {
    "/root/sessions": [{ path: "/root/sessions/run1", type: FileType.DIR }],
    "/root/sessions/run1": [{ path: "/root/sessions/run1/foo-abc.jsonl", type: FileType.FILE }],
  };
  const sandbox: any = {
    files: {
      list: async (p: string) => tree[p] ?? [],
    },
  };

  const files = await findRemoteJsonlFiles({
    sandbox,
    sessionsRoot: "/root/sessions",
    sessionId: "abc",
    timeoutMs: 100,
    pollMs: 10,
  });

  assert.deepEqual(files, ["/root/sessions/run1/foo-abc.jsonl"]);
});

test("RemoteLogSync mirrors remote JSONL to local file without duplication", async () => {
  const remotePath = "/logs/run.jsonl";
  const remoteContent = "line1\nline2\n";
  const bytes = Buffer.from(remoteContent);

  const sandbox: any = {
    commands: {
      run: async (cmd: string) => {
        const match = cmd.match(/tail -c \\+(\\d+) (\"[^\"]+\")/);
        if (!match || !match[1] || !match[2]) return { stdout: "", stderr: "", exitCode: 0 };
        const start = Number(match[1]);
        const pathArg = JSON.parse(match[2]);
        if (pathArg !== remotePath) return { stdout: "", stderr: "", exitCode: 0 };
        const slice = bytes.slice(Math.max(0, start - 1));
        return { stdout: slice.toString("utf8"), stderr: "", exitCode: 0 };
      },
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
