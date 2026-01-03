import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { CommandExitError } from "e2b";
import type { Logger } from "../src/runtime/log.js";
import type { CloudE2BSection } from "../src/runtime/config.js";
import { E2BCloudProvider } from "../src/runtime/cloud/e2bProvider.js";

function makeLogger(): Logger {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

function makeConfig(overrides?: Partial<CloudE2BSection>): CloudE2BSection {
  return {
    api_key: "",
    template_id: "",
    domain: "",
    timeout_ms: 300_000,
    request_timeout_ms: 60_000,
    command_timeout_ms: 60_000,
    secure: true,
    allow_internet_access: true,
    workspace_root: "/home/user/tintin",
    codex_binary: "codex",
    claude_binary: "claude",
    ...overrides,
  };
}

function createFakeSandbox() {
  const files = new Map<string, Uint8Array>();
  const dirs: string[] = [];
  const commands: Array<{ cmd: string; opts: any }> = [];
  let killed = false;

  const sandbox: any = {
    sandboxId: "sb-test",
    sandboxDomain: "sb.e2b.dev",
    files: {
      makeDir: async (p: string) => {
        dirs.push(p);
        return true;
      },
      write: async (pathOrEntries: any, data?: any) => {
        if (Array.isArray(pathOrEntries)) {
          for (const entry of pathOrEntries) {
            const buf = typeof entry.data === "string" ? Buffer.from(entry.data) : Buffer.from(entry.data);
            files.set(entry.path, new Uint8Array(buf));
          }
          return [];
        }
        const buf = typeof data === "string" ? Buffer.from(data) : Buffer.from(data);
        files.set(pathOrEntries, new Uint8Array(buf));
        return { path: pathOrEntries };
      },
      read: async (p: string) => {
        return files.get(p) ?? new Uint8Array();
      },
      remove: async (p: string) => {
        files.delete(p);
      },
    },
    commands: {
      run: async (cmd: string, opts?: any) => {
        commands.push({ cmd, opts });
        if (cmd.startsWith("tar -czf ")) {
          const match = cmd.match(/tar -czf ("[^"]+")/);
          if (match) {
            const outPath = JSON.parse(match[1]!);
            files.set(outPath, new Uint8Array(Buffer.from("snapshot")));
          }
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    },
    kill: async () => {
      killed = true;
    },
    __state: { files, dirs, commands, get killed() { return killed; } },
  };

  return sandbox;
}

test("E2BCloudProvider createWorkspace uses sandbox factory and workspace root", async () => {
  const sandbox = createFakeSandbox();
  let seenTemplate: string | null = null;
  let seenOpts: Record<string, unknown> | null = null;
  const provider = new E2BCloudProvider(makeConfig({ template_id: "tmpl-1" }), makeLogger(), {
    sandboxFactory: async (templateId, opts) => {
      seenTemplate = templateId;
      seenOpts = opts;
      return sandbox;
    },
  });

  const workspace = await provider.createWorkspace({ prefix: "test" });
  assert.equal(workspace.id, "sb-test");
  assert.equal(workspace.rootPath, "/home/user/tintin");
  assert.equal(seenTemplate, "tmpl-1");
  assert.ok(seenOpts);
  assert.ok(sandbox.__state.dirs.includes("/home/user/tintin"));
});

test("E2BCloudProvider uploadFiles writes files and chmods", async () => {
  const sandbox = createFakeSandbox();
  const provider = new E2BCloudProvider(makeConfig(), makeLogger(), {
    sandboxFactory: async () => sandbox,
  });
  const workspace = await provider.createWorkspace({});

  await provider.uploadFiles(workspace, [
    { path: "a.txt", content: "hello", mode: "0644" },
    { path: "b.txt", content: Buffer.from("world") },
  ]);

  const commands = sandbox.__state.commands.map((c: any) => c.cmd);
  assert.ok(commands.some((cmd: string) => cmd.includes("chmod 644")));
  assert.ok(sandbox.__state.files.has("/home/user/tintin/a.txt"));
  assert.ok(sandbox.__state.files.has("/home/user/tintin/b.txt"));
});

test("E2BCloudProvider runCommands forwards env and cwd", async () => {
  const sandbox = createFakeSandbox();
  const provider = new E2BCloudProvider(makeConfig(), makeLogger(), {
    sandboxFactory: async () => sandbox,
  });
  const workspace = await provider.createWorkspace({});

  await provider.runCommands({
    workspace,
    cwd: "/home/user/tintin/repo",
    commands: ["echo 1", "echo 2"],
    env: { HELLO: "world" },
  });

  assert.equal(sandbox.__state.commands.length, 2);
  assert.equal(sandbox.__state.commands[0].opts.cwd, "/home/user/tintin/repo");
  assert.equal(sandbox.__state.commands[0].opts.envs.HELLO, "world");
});

test("E2BCloudProvider snapshotWorkspace writes tarball to snapshot dir", async () => {
  const sandbox = createFakeSandbox();
  const tmp = await mkdtemp(path.join(os.tmpdir(), "tintin-snapshot-"));
  const provider = new E2BCloudProvider(makeConfig(), makeLogger(), {
    snapshotDir: tmp,
    sandboxFactory: async () => sandbox,
  });
  const workspace = await provider.createWorkspace({});

  const snapshotId = await provider.snapshotWorkspace(workspace, "setup");
  const snapshotPath = path.join(tmp, `${snapshotId}.tar.gz`);
  const content = await readFile(snapshotPath, "utf8");
  assert.equal(content, "snapshot");

  await rm(tmp, { recursive: true, force: true });
});

test("E2BCloudProvider pullDiff uses stdout on command error", async () => {
  const sandbox = createFakeSandbox();
  sandbox.commands.run = async () => {
    throw new CommandExitError({ exitCode: 1, error: "fail", stdout: "diff-output", stderr: "" });
  };
  const provider = new E2BCloudProvider(makeConfig(), makeLogger(), {
    sandboxFactory: async () => sandbox,
  });
  const workspace = await provider.createWorkspace({});

  const diff = await provider.pullDiff({ workspace, cwd: "/home/user/tintin/repo" });
  assert.equal(diff.diff, "diff-output");
});
