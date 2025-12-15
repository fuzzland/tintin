#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, open, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import * as toml from "@iarna/toml";
import { loadConfig } from "./src/runtime/config.js";
import { createDatabase, type SessionStatus } from "./src/runtime/db.js";
import { createLogger } from "./src/runtime/log.js";
import { validateAndResolveProjectPath } from "./src/runtime/security.js";
import { sleep } from "./src/runtime/util.js";

const ROOT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_LINES = 200;

interface CliArgs {
  command: string | null;
  configPath: string;
  rest: string[];
  lines: number;
  githubReposDir?: string;
  githubToken?: string;
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
  let githubReposDir: string | undefined;
  let githubToken: string | undefined;
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
    if (arg === "--github-dir" || arg === "--repos-dir") {
      const v = argv[i + 1];
      if (!v) throw new Error("--github-dir requires a value");
      githubReposDir = v;
      i++;
      continue;
    }
    if (arg.startsWith("--github-dir=") || arg.startsWith("--repos-dir=")) {
      const [, v] = arg.split("=", 2);
      if (v) githubReposDir = v;
      continue;
    }
    if (arg === "--github-token" || arg === "--token") {
      const v = argv[i + 1];
      if (!v) throw new Error("--github-token requires a value");
      githubToken = v;
      i++;
      continue;
    }
    if (arg.startsWith("--github-token=") || arg.startsWith("--token=")) {
      const [, v] = arg.split("=", 2);
      if (v) githubToken = v;
      continue;
    }
    if (!command) {
      command = arg;
      continue;
    }
    rest.push(arg);
  }

  return {
    command,
    configPath,
    rest,
    lines: Number.isFinite(lines) && lines > 0 ? Math.floor(lines) : DEFAULT_LINES,
    githubReposDir,
    githubToken,
  };
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

function slugifyId(name: string): string {
  const base = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return base.length > 0 ? base : `project-${Date.now()}`;
}

function parseGithubRepoPath(input: string): { owner: string; repo: string; url: string } | null {
  const trimmed = input.trim();
  const https = trimmed.match(/^https?:\/\/github\.com\/([^/]+)\/([^/#?]+)(?:\.git)?(?:[?#/].*)?$/i);
  if (https) {
    const owner = https[1]!;
    const repo = https[2]!.replace(/\.git$/, "");
    return { owner, repo, url: `https://github.com/${owner}/${repo}.git` };
  }

  const bareHttps = trimmed.match(/^github\.com\/([^/]+)\/([^/#?]+)(?:\.git)?(?:[?#/].*)?$/i);
  if (bareHttps) {
    const owner = bareHttps[1]!;
    const repo = bareHttps[2]!.replace(/\.git$/, "");
    return { owner, repo, url: `https://github.com/${owner}/${repo}.git` };
  }

  const ssh = trimmed.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (ssh) {
    const owner = ssh[1]!;
    const repo = ssh[2]!.replace(/\.git$/, "");
    return { owner, repo, url: `https://github.com/${owner}/${repo}.git` };
  }

  const shorthand = trimmed.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:\.git)?$/);
  if (shorthand) {
    const owner = shorthand[1]!;
    const repo = shorthand[2]!.replace(/\.git$/, "");
    return { owner, repo, url: `https://github.com/${owner}/${repo}.git` };
  }

  return null;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

function buildCloneUrl(repoUrl: string, token: string | null): { url: string; redacted: string } {
  const redacted = repoUrl.replace(/^https?:\/\//, "https://***@");
  if (!token) return { url: repoUrl, redacted: repoUrl };
  if (repoUrl.startsWith("https://")) {
    const encodedToken = token.trim();
    return { url: repoUrl.replace(/^https:\/\//, `https://${encodedToken}@`), redacted };
  }
  return { url: repoUrl, redacted: repoUrl };
}

async function cloneGithubRepo(opts: { repoUrl: string; targetDir: string; token?: string | null }) {
  const { url: cloneUrl, redacted } = buildCloneUrl(opts.repoUrl, opts.token ?? null);
  await mkdir(path.dirname(opts.targetDir), { recursive: true });
  console.log(`Cloning ${redacted} into ${opts.targetDir}…`);

  await new Promise<void>((resolve, reject) => {
    const child = spawn("git", ["clone", cloneUrl, opts.targetDir], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    let stderr = "";
    let stdout = "";
    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      if (code === 0) return resolve();
      const combined = (stderr || stdout).replaceAll(cloneUrl, redacted).trim();
      reject(new Error(`git clone failed (exit ${code ?? "?"})${combined ? `: ${combined}` : ""}`));
    });
  });
}

function sanitizePathSegment(segment: string): string {
  const cleaned = segment.replace(/[^A-Za-z0-9._-]/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned.length > 0 ? cleaned : "repo";
}

function isGitUrl(input: string): boolean {
  return (
    /^(?:https?|ssh|git|file):\/\//i.test(input.trim()) ||
    /^git@[^:]+:[^]+/.test(input.trim()) ||
    /^[^@]+@[^:]+:[^]+/.test(input.trim())
  );
}

function deriveCloneTargetDir(rootDir: string, rawUrl: string): string {
  const trimmed = rawUrl.trim();
  const safeRoot = path.isAbsolute(rootDir) ? rootDir : path.resolve(rootDir);
  try {
    const u = new URL(trimmed);
    const host = sanitizePathSegment(u.hostname || "repo");
    const parts = u.pathname.split("/").filter(Boolean).map(sanitizePathSegment);
    const repoName = parts.pop() ?? "repo";
    return path.join(safeRoot, host, ...parts, repoName.replace(/\.git$/, ""));
  } catch {
    // fallthrough to scp-like parsing
  }

  const scp = trimmed.match(/^[^@]+@([^:]+):(.+)$/);
  if (scp) {
    const host = sanitizePathSegment(scp[1]!);
    const pathPart = scp[2]!.replace(/^\/+/, "");
    const parts = pathPart.split("/").filter(Boolean).map(sanitizePathSegment);
    const repoName = parts.pop() ?? "repo";
    return path.join(safeRoot, host, ...parts, repoName.replace(/\.git$/, ""));
  }

  const fallback = sanitizePathSegment(trimmed.replace(/\.git$/, ""));
  return path.join(safeRoot, fallback);
}

async function appendProjectToConfig(configPath: string, project: { id: string; name: string; path: string }) {
  const block = toml.stringify({ projects: [project] }).trim();
  const raw = await readFile(configPath, "utf8");
  const trimmed = raw.trimEnd();
  const sep = trimmed.length === 0 ? "" : "\n\n";
  await writeFile(configPath, `${trimmed}${sep}${block}\n`, "utf8");
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

async function addNewProject(args: CliArgs) {
  const [projectNameRaw, rawPath, providedId, extra] = args.rest;
  if (!projectNameRaw || !rawPath || extra !== undefined) {
    console.error("Usage: tintin new <project name> <path | git url | github:owner/repo> [id]");
    console.error("Options: --github-dir <dir> (clone root), --github-token <ghp_xxx>");
    process.exitCode = 1;
    return;
  }

  const projectName = projectNameRaw.trim();
  if (!projectName) {
    console.error("Project name must be non-empty.");
    process.exitCode = 1;
    return;
  }

  const configPath = path.resolve(process.cwd(), args.configPath);
  const config = await loadConfig(configPath);

  const existingIds = new Set(config.projects.map((p) => p.id));
  const existingPaths = new Set<string>();
  for (const p of config.projects) {
    if (p.path === "*") continue;
    const candidate = path.isAbsolute(p.path) ? p.path : path.resolve(config.config_dir, p.path);
    const real = await realpath(candidate).catch(() => candidate);
    existingPaths.add(real);
  }

  const providedIdNormalized = typeof providedId === "string" ? providedId.trim() : "";
  const baseId = providedIdNormalized.length > 0 ? providedIdNormalized : slugifyId(projectName);
  let projectId = baseId;
  if (existingIds.has(projectId)) {
    if (providedId) {
      console.error(`Project id already exists: ${projectId}`);
      process.exitCode = 1;
      return;
    }
    let suffix = 2;
    while (existingIds.has(`${baseId}-${suffix}`)) suffix++;
    projectId = `${baseId}-${suffix}`;
  }

  const sourceRaw = rawPath.trim();
  const cloneRootOverride =
    args.githubReposDir ?? process.env.TINTIN_GITHUB_ROOT ?? process.env.TINTIN_GITHUB_REPOS_DIR;
  const cloneRoot =
    cloneRootOverride && cloneRootOverride.length > 0
      ? path.isAbsolute(cloneRootOverride)
        ? cloneRootOverride
        : path.resolve(config.config_dir, cloneRootOverride)
      : config.bot.github_repos_dir;

  const token =
    args.githubToken ??
    process.env.TINTIN_GITHUB_TOKEN ??
    process.env.GITHUB_TOKEN ??
    process.env.GH_TOKEN ??
    null;

  const githubPrefixed = sourceRaw.startsWith("github:") ? sourceRaw.slice("github:".length) : null;
  const githubParsed = githubPrefixed ? parseGithubRepoPath(githubPrefixed) : null;
  if (githubPrefixed && !githubParsed) {
    console.error("Invalid GitHub source. Use github:<owner>/<repo> or github:https://github.com/owner/repo");
    process.exitCode = 1;
    return;
  }

  let resolvedPath: string;
  let clonedFrom: string | null = null;
  const candidatePath = path.isAbsolute(sourceRaw) ? sourceRaw : path.resolve(config.config_dir, sourceRaw);
  const existingDir = await stat(candidatePath).catch(() => null);

  if (!existingDir && !githubParsed) {
    const looksGithub = parseGithubRepoPath(sourceRaw);
    if (looksGithub) {
      console.error(
        "For GitHub sources, prefix with github:, e.g. github:owner/repo or github:https://github.com/owner/repo",
      );
      process.exitCode = 1;
      return;
    }
  }

  if (githubParsed) {
    const targetDir = path.join(cloneRoot, githubParsed.owner, githubParsed.repo);
    const repoStat = await stat(targetDir).catch(() => null);
    if (repoStat && repoStat.isDirectory()) {
      if (!(await pathExists(path.join(targetDir, ".git")))) {
        console.error(`Target ${targetDir} exists but is not a git repo; choose a different --github-dir.`);
        process.exitCode = 1;
        return;
      }
      console.log(`Using existing clone at ${targetDir}`);
    } else {
      await cloneGithubRepo({ repoUrl: githubParsed.url, targetDir, token });
      clonedFrom = githubParsed.url;
    }
    resolvedPath = targetDir;
  } else if (existingDir?.isDirectory()) {
    resolvedPath = candidatePath;
  } else if (isGitUrl(sourceRaw)) {
    const targetDir = deriveCloneTargetDir(cloneRoot, sourceRaw);
    const repoStat = await stat(targetDir).catch(() => null);
    if (repoStat && repoStat.isDirectory()) {
      if (!(await pathExists(path.join(targetDir, ".git")))) {
        console.error(`Target ${targetDir} exists but is not a git repo; choose a different --github-dir.`);
        process.exitCode = 1;
        return;
      }
      console.log(`Using existing clone at ${targetDir}`);
    } else {
      await cloneGithubRepo({ repoUrl: sourceRaw, targetDir, token });
      clonedFrom = sourceRaw;
    }
    resolvedPath = targetDir;
  } else {
    console.error(
      "Path does not exist. Provide an existing directory, a git URL, or prefix GitHub sources with github:owner/repo.",
    );
    process.exitCode = 1;
    return;
  }

  const canonicalPath = await realpath(resolvedPath).catch(() => path.resolve(resolvedPath));
  if (existingPaths.has(canonicalPath)) {
    console.error(`A project with this path already exists: ${canonicalPath}`);
    process.exitCode = 1;
    return;
  }

  try {
    const validated = await validateAndResolveProjectPath(
      config,
      { id: projectId, name: projectName, path: canonicalPath },
      null,
    );
    const finalPath = validated.project_path_resolved;
    if (existingPaths.has(finalPath)) {
      console.error(`A project with this path already exists: ${finalPath}`);
      process.exitCode = 1;
      return;
    }

    await appendProjectToConfig(configPath, { id: projectId, name: projectName, path: finalPath });
    console.log(`Added project '${projectName}' (id=${projectId}) at ${finalPath}`);
    if (clonedFrom) {
      console.log(`${clonedFrom.includes("github.com") ? "GitHub" : "Git"} source: ${clonedFrom}${token ? " (token not saved)" : ""}`);
    }
    console.log(`Use this project id (${projectId}) when starting a new session from chat.`);
    console.log("Restart the tintin daemon to load the updated config.");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`Failed to add project: ${msg}`);
    if (clonedFrom) console.error("You may want to delete the cloned directory if not needed.");
    process.exitCode = 1;
  }
}

function showHelp() {
  console.log(`tintin daemon manager

Usage:
  tintin start [--config path]     Start the daemon (background)
  tintin stop [--config path]      Stop the daemon
  tintin status [--config path]    Show daemon + session status
  tintin log [--config path]       Show last ${DEFAULT_LINES} log lines (use --lines N)
  tintin new <name> <path> [id]    Add a project (use github:<owner>/<repo> for GitHub; git URLs supported)
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
    case "new":
      await addNewProject(args);
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
