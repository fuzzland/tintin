import test from "node:test";
import assert from "node:assert/strict";
import type { Logger } from "../src/runtime/log.js";
import type { CloudModalSection } from "../src/runtime/config.js";
import { ModalCloudProvider } from "../src/runtime/cloud/modalProvider.js";

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

function makeConfig(overrides?: Partial<CloudModalSection>): CloudModalSection {
  return {
    token_id: "",
    token_secret: "",
    environment: "",
    endpoint: "",
    app_name: "tintin-cloud",
    image: "debian:12",
    image_id: "",
    timeout_ms: 300_000,
    idle_timeout_ms: 300_000,
    request_timeout_ms: 60_000,
    command_timeout_ms: 60_000,
    block_network: false,
    cidr_allowlist: [],
    workspace_root: "/workspace/tintin",
    codex_binary: "codex",
    claude_binary: "claude",
    ...overrides,
  };
}

function makeProc(stdout = "", stderr = "", exitCode = 0): ExecResult {
  return {
    stdout: { readText: async () => stdout },
    stderr: { readText: async () => stderr },
    wait: async () => exitCode,
  };
}

function createFakeSandbox(execHandler?: (command: string[], params: any) => ExecResult) {
  const files = new Map<string, Uint8Array>();
  const calls: Array<{ command: string[]; params: any }> = [];
  let killed = false;

  const sandbox: any = {
    sandboxId: "sb-test",
    open: async (target: string) => {
      let buffer = Buffer.alloc(0);
      return {
        write: async (data: Uint8Array) => {
          buffer = Buffer.concat([buffer, Buffer.from(data)]);
        },
        flush: async () => {},
        close: async () => {
          files.set(target, buffer);
        },
      };
    },
    exec: async (command: string[], params: any) => {
      calls.push({ command, params });
      return execHandler ? execHandler(command, params) : makeProc();
    },
    terminate: async () => {
      killed = true;
    },
    snapshotFilesystem: async () => ({ imageId: "im-snap" }),
    __state: {
      files,
      calls,
      get killed() {
        return killed;
      },
    },
  };

  return sandbox;
}

function createFakeClient(sandbox: any) {
  const app = { appId: "app-test" };
  const image = { imageId: "im-base" };
  return {
    apps: { fromName: async () => app },
    images: { fromId: async () => image, fromRegistry: () => image },
    sandboxes: { create: async () => sandbox },
  } as any;
}

test("ModalCloudProvider createWorkspace uses modal client and workspace root", async () => {
  const sandbox = createFakeSandbox();
  const provider = new ModalCloudProvider(makeConfig(), makeLogger(), { client: createFakeClient(sandbox) });

  const workspace = await provider.createWorkspace({ prefix: "test" });
  assert.equal(workspace.id, "sb-test");
  assert.equal(workspace.rootPath, "/workspace/tintin");
  assert.ok(sandbox.__state.calls.some((call: any) => call.command[2]?.includes("mkdir -p")));
});

test("ModalCloudProvider uploadFiles writes files and chmods", async () => {
  const sandbox = createFakeSandbox();
  const provider = new ModalCloudProvider(makeConfig(), makeLogger(), { client: createFakeClient(sandbox) });
  const workspace = await provider.createWorkspace({});
  sandbox.__state.calls.length = 0;

  await provider.uploadFiles(workspace, [
    { path: "a.txt", content: "hello", mode: "0644" },
    { path: "b.txt", content: Buffer.from("world") },
  ]);

  const commands = sandbox.__state.calls.map((c: any) => c.command[2]);
  assert.ok(commands.some((cmd: string) => cmd.includes("chmod 644")));
  assert.ok(sandbox.__state.files.has("/workspace/tintin/a.txt"));
  assert.ok(sandbox.__state.files.has("/workspace/tintin/b.txt"));
});

test("ModalCloudProvider runCommands forwards env and cwd", async () => {
  const sandbox = createFakeSandbox();
  const provider = new ModalCloudProvider(makeConfig(), makeLogger(), { client: createFakeClient(sandbox) });
  const workspace = await provider.createWorkspace({});
  sandbox.__state.calls.length = 0;

  await provider.runCommands({
    workspace,
    cwd: "/workspace/tintin/repo",
    commands: ["echo 1", "echo 2"],
    env: { HELLO: "world" },
  });

  assert.equal(sandbox.__state.calls.length, 2);
  assert.equal(sandbox.__state.calls[0].params.workdir, "/workspace/tintin/repo");
  assert.equal(sandbox.__state.calls[0].params.env.HELLO, "world");
});

test("ModalCloudProvider snapshotWorkspace returns image id", async () => {
  const sandbox = createFakeSandbox();
  const provider = new ModalCloudProvider(makeConfig(), makeLogger(), { client: createFakeClient(sandbox) });
  const workspace = await provider.createWorkspace({});

  const snapshotId = await provider.snapshotWorkspace(workspace, "setup");
  assert.equal(snapshotId, "im-snap");
});

test("ModalCloudProvider pullDiff uses stdout on command error", async () => {
  const sandbox = createFakeSandbox((command) => {
    if (command[2] === "git diff") return makeProc("diff-output", "", 1);
    return makeProc();
  });
  const provider = new ModalCloudProvider(makeConfig(), makeLogger(), { client: createFakeClient(sandbox) });
  const workspace = await provider.createWorkspace({});

  const diff = await provider.pullDiff({ workspace, cwd: "/workspace/tintin/repo" });
  assert.equal(diff.diff, "diff-output");
});
