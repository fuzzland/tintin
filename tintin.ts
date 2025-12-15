#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import { mkdir, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./src/runtime/config.js";
import { createDatabase, type SessionStatus } from "./src/runtime/db.js";
import { createLogger } from "./src/runtime/log.js";
import { sleep } from "./src/runtime/util.js";

const ROOT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_LINES = 200;

interface CliArgs {
  command: string | null;
  configPath: string;
  rest: string[];
  lines: number;
}

interface DaemonInfo {
  pid: number;
  configPath: string;
  logFile: string;
  startedAt: number;
}

interface DaemonPaths {
  dataDir: string;
  pidFile: string;
  infoFile: string;
  logFile: string;
}

function parseCliArgs(argv: string[]): CliArgs {
  let command: string | null = null;
  let configPath = process.env.CONFIG_PATH ?? "./config.toml";
  let lines = DEFAULT_LINES;
  const rest: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg) continue;
    if (arg === "--config" || arg === "-c") {
      const v = argv[i + 1];
      if (!v) throw new Error("--config requires a value");
      configPath = v;
      i++;
      continue;
    }
    if (arg.startsWith("--config=")) {
      configPath = arg.slice("--config=".length);
      continue;
    }
    if (arg === "--lines") {
      const v = argv[i + 1];
      if (!v) throw new Error("--lines requires a value");
      lines = Number(v);
      i++;
      continue;
    }
    if (arg.startsWith("--lines=")) {
      lines = Number(arg.slice("--lines=".length));
      continue;
    }
    if (!command) {
      command = arg;
      continue;
    }
    rest.push(arg);
  }

  return { command, configPath, rest, lines: Number.isFinite(lines) && lines > 0 ? Math.floor(lines) : DEFAULT_LINES };
}

function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const code = e && typeof e === "object" && "code" in e ? (e as any).code : null;
    return code === "EPERM";
  }
}

async function loadConfigAndPaths(configPathRaw: string, ensureDataDir: boolean): Promise<{
  configPath: string;
  paths: DaemonPaths;
  logLevel: string | undefined;
}> {
  const configPath = path.resolve(process.cwd(), configPathRaw);
  const config = await loadConfig(configPath);

  if (ensureDataDir) await mkdir(config.bot.data_dir, { recursive: true });

  return {
    configPath,
    paths: {
      dataDir: config.bot.data_dir,
      pidFile: path.join(config.bot.data_dir, "tintin.pid"),
      infoFile: path.join(config.bot.data_dir, "tintin-daemon.json"),
      logFile: path.join(config.bot.data_dir, "tintin.log"),
    },
    logLevel: config.bot.log_level,
  };
}

async function readDaemonInfo(infoFile: string): Promise<DaemonInfo | null> {
  try {
    const text = await readFile(infoFile, "utf8");
    const parsed = JSON.parse(text) as DaemonInfo;
    if (typeof parsed.pid !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writeDaemonInfo(paths: DaemonPaths, info: DaemonInfo) {
  await writeFile(paths.infoFile, JSON.stringify(info, null, 2));
  await writeFile(paths.pidFile, `${info.pid}\n`);
}

async function clearDaemonFiles(paths: DaemonPaths) {
  await Promise.all([
    rm(paths.infoFile, { force: true }),
    rm(paths.pidFile, { force: true }),
  ]);
}

async function startDaemon(args: CliArgs) {
  const { configPath, paths } = await loadConfigAndPaths(args.configPath, true);

  const existing = await readDaemonInfo(paths.infoFile);
  if (existing && isPidAlive(existing.pid)) {
    console.log(`tintin daemon already running (pid ${existing.pid})`);
    return;
  }
  if (existing) await clearDaemonFiles(paths);

  const logHandle = await open(paths.logFile, "a");
  const logFd = logHandle.fd;

  const childEnv: NodeJS.ProcessEnv = { ...process.env, CONFIG_PATH: configPath };
  if (!childEnv.BOT_AUTO_MIGRATE) childEnv.BOT_AUTO_MIGRATE = "1";

  const child = spawn(process.execPath, [path.join(ROOT_DIR, "src/main.js"), "--config", configPath], {
    cwd: ROOT_DIR,
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: childEnv,
  });
  logHandle.close();

  if (!child.pid) {
    throw new Error("Failed to spawn tintin daemon");
  }

  const info: DaemonInfo = {
    pid: child.pid,
    configPath,
    logFile: paths.logFile,
    startedAt: Date.now(),
  };
  await writeDaemonInfo(paths, info);

  child.unref();
  console.log(`tintin daemon started (pid ${child.pid})`);
  console.log(`logs: ${paths.logFile}`);
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!isPidAlive(pid)) return true;
    await sleep(200);
  }
  return !isPidAlive(pid);
}

async function stopDaemon(args: CliArgs) {
  const { paths } = await loadConfigAndPaths(args.configPath, false);
  const info = await readDaemonInfo(paths.infoFile);
  if (!info) {
    console.log("tintin daemon is not running (no pid file found)");
    return;
  }

  if (!isPidAlive(info.pid)) {
    console.log(`Removing stale pid file (pid ${info.pid} not running)`);
    await clearDaemonFiles(paths);
    return;
  }

  console.log(`Stopping tintin daemon (pid ${info.pid})…`);
  try {
    process.kill(info.pid, "SIGTERM");
  } catch (e) {
    console.error(`Failed to send SIGTERM: ${String(e)}`);
    return;
  }

  const exited = await waitForExit(info.pid, 8000);
  if (!exited) {
    console.error("Process did not exit after SIGTERM. It may still be shutting down.");
    return;
  }

  await clearDaemonFiles(paths);
  console.log("Stopped.");
}

async function tailFile(filePath: string, lines: number): Promise<string> {
  const st = await stat(filePath);
  if (!st.isFile()) throw new Error("log path is not a file");
  const chunkSize = Math.min(st.size, 1_000_000);
  const start = Math.max(0, st.size - chunkSize);
  const fh = await open(filePath, "r");
  const buffer = Buffer.alloc(chunkSize);
  const { bytesRead } = await fh.read({ buffer, position: start });
  await fh.close();
  const text = buffer.slice(0, bytesRead).toString("utf8");
  const parts = text.trimEnd().split(/\r?\n/);
  return parts.slice(-lines).join("\n");
}

async function showLogs(args: CliArgs) {
  const { paths } = await loadConfigAndPaths(args.configPath, false);
  try {
    await stat(paths.logFile);
  } catch {
    console.log(`No log file yet (${paths.logFile})`);
    return;
  }

  const body = await tailFile(paths.logFile, args.lines);
  console.log(`==> ${paths.logFile} (last ${args.lines} lines)`);
  console.log(body);
}

async function fetchSessionCounts(configPath: string, logLevel: string | undefined): Promise<
  | { ok: true; total: number; counts: Record<SessionStatus, number> }
  | { ok: false; error: string }
> {
  const logger = createLogger(logLevel ?? "warn");
  try {
    const config = await loadConfig(configPath);
    const db = await createDatabase(config, logger);
    const rows = await db
      .selectFrom("sessions")
      .select(["status"])
      .select(({ fn }) => fn.countAll().as("count"))
      .groupBy("status")
      .execute();

    const counts: Record<SessionStatus, number> = {
      wizard: 0,
      starting: 0,
      running: 0,
      finished: 0,
      error: 0,
      killed: 0,
    };
    let total = 0;
    for (const row of rows as Array<{ status: SessionStatus; count: number }>) {
      const status = row.status;
      const count = Number((row as any).count ?? 0);
      if (status in counts) counts[status] = count;
      total += count;
    }

    await db.destroy();
    return { ok: true, total, counts };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg };
  }
}

function formatTimestamp(ms: number): string {
  return new Date(ms).toISOString();
}

async function showStatus(args: CliArgs) {
  const { configPath, paths, logLevel } = await loadConfigAndPaths(args.configPath, false);
  const info = await readDaemonInfo(paths.infoFile);
  const running = info ? isPidAlive(info.pid) : false;
  if (info && !running) {
    await clearDaemonFiles(paths);
  }

  console.log(`daemon: ${running ? `running (pid ${info?.pid ?? "?"})` : "not running"}`);
  console.log(`config: ${info?.configPath ?? configPath}`);
  console.log(`log: ${paths.logFile}`);
  if (info?.startedAt) console.log(`started: ${formatTimestamp(info.startedAt)}`);

  const sessionCounts = await fetchSessionCounts(configPath, logLevel);
  if (!sessionCounts.ok) {
    console.log(`sessions: unavailable (${sessionCounts.error})`);
    return;
  }

  const live = sessionCounts.counts.running + sessionCounts.counts.starting;
  const killed = sessionCounts.counts.killed;
  console.log(
    `sessions: total=${sessionCounts.total} live=${live} running=${sessionCounts.counts.running} starting=${sessionCounts.counts.starting} ` +
      `killed=${killed} finished=${sessionCounts.counts.finished} error=${sessionCounts.counts.error}`,
  );
}

function showHelp() {
  console.log(`tintin daemon manager

Usage:
  tintin start [--config path]     Start the daemon (background)
  tintin stop [--config path]      Stop the daemon
  tintin status [--config path]    Show daemon + session status
  tintin log [--config path]       Show last ${DEFAULT_LINES} log lines (use --lines N)
`);
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  switch (args.command) {
    case "start":
      await startDaemon(args);
      return;
    case "stop":
      await stopDaemon(args);
      return;
    case "status":
      await showStatus(args);
      return;
    case "log":
      await showLogs(args);
      return;
    case null:
    case undefined:
    case "help":
    case "--help":
    case "-h":
      showHelp();
      return;
    default:
      console.error(`Unknown command: ${args.command}`);
      showHelp();
      process.exitCode = 1;
  }
}

void main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
