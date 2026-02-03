#!/usr/bin/env node
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const net = require("node:net");
const http = require("node:http");
const path = require("node:path");
const { spawn } = require("node:child_process");

const LOG_PREFIX = "[tintin-mcp-bootstrap]";
const CONFIG_B64 = process.env.TINTIN_MCP_CONFIG_B64 || "";
const CONFIG_PATH = process.env.TINTIN_MCP_CONFIG_PATH || "";
const INSTALLED_PW_PACKAGE = process.env.TINTIN_PLAYWRIGHT_MCP_PACKAGE || "";
const SESSION_ID = process.env.TINTIN_AGENT_SESSION || "";

function log(message) {
  const suffix = SESSION_ID ? ` session=${SESSION_ID}` : "";
  console.error(`${LOG_PREFIX}${suffix} ${message}`);
}

function fail(message) {
  log(message);
  process.exit(1);
}

async function readConfig() {
  if (CONFIG_B64) {
    try {
      const decoded = Buffer.from(CONFIG_B64, "base64").toString("utf8");
      return JSON.parse(decoded);
    } catch (err) {
      fail(`invalid TINTIN_MCP_CONFIG_B64: ${String(err)}`);
    }
  }
  if (CONFIG_PATH) {
    try {
      const raw = await fsp.readFile(CONFIG_PATH, "utf8");
      return JSON.parse(raw);
    } catch (err) {
      fail(`failed to read TINTIN_MCP_CONFIG_PATH=${CONFIG_PATH}: ${String(err)}`);
    }
  }
  return null;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getProviders(config) {
  if (!isRecord(config)) return {};
  const providers = config.providers;
  return isRecord(providers) ? providers : {};
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function canConnect(host, port) {
  const targetHost = resolveConnectHost(host);
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: targetHost, port });
    socket.once("connect", () => {
      socket.end();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
    socket.setTimeout(1000, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

function resolveConnectHost(bindHost) {
  const localHosts = new Set(["127.0.0.1", "::1", "0.0.0.0", "[::]"]);
  return localHosts.has(bindHost) ? "localhost" : bindHost;
}

async function waitForPort(host, port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const connectHost = resolveConnectHost(host);
  while (Date.now() < deadline) {
    if (await canConnect(connectHost, port)) return;
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${connectHost}:${port}`);
}

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: 1500 }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(JSON.parse(body));
          } catch (err) {
            reject(err);
          }
        } else {
          reject(new Error(`status ${res.statusCode || 0}`));
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy(new Error("timeout"));
    });
  });
}

async function discoverCdpUrl() {
  const endpoints = [
    "http://127.0.0.1:9222/json/version",
    "http://127.0.0.1:9223/json/version",
  ];
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    for (const endpoint of endpoints) {
      try {
        const data = await httpGetJson(endpoint);
        if (data && typeof data.webSocketDebuggerUrl === "string" && data.webSocketDebuggerUrl.length > 0) {
          return data.webSocketDebuggerUrl;
        }
      } catch {
        // ignore and retry
      }
    }
    await sleep(500);
  }
  return "";
}

function normalizeDir(value, fallback, label) {
  if (typeof value !== "string" || value.trim().length === 0) return fallback;
  const resolved = path.isAbsolute(value) ? value : path.resolve("/home/ubuntu", value);
  if (resolved.startsWith("/home/ubuntu") || resolved.startsWith("/workspace")) return resolved;
  log(`${label} path ${resolved} is not container-safe; using ${fallback}`);
  return fallback;
}

function ensureDirSync(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    fail(`failed to create directory ${dir}: ${String(err)}`);
  }
}

function buildPlaywrightArgs(cfg, port, cdpUrl, userDataDir, outputDir, executablePath) {
  const args = [
    "--no-install",
    cfg.package,
    "--browser",
    cfg.browser,
    "--host",
    cfg.host,
    "--port",
    String(port),
    "--user-data-dir",
    userDataDir,
    "--output-dir",
    outputDir,
    "--snapshot-mode",
    cfg.snapshot_mode,
    "--image-responses",
    cfg.image_responses,
    "--shared-browser-context",
    "--timeout-navigation",
    String(Math.max(1_000, Math.min(cfg.timeout_ms, 60_000))),
  ];
  if (cfg.user_agent) args.push("--user-agent", cfg.user_agent);
  if (cfg.viewport_size) args.push("--viewport-size", cfg.viewport_size);
  if (executablePath) args.push("--executable-path", executablePath);
  if (cfg.headless) args.push("--headless");
  if (cdpUrl) args.push("--cdp-endpoint", cdpUrl);
  return args;
}

async function startPlaywrightProvider(name, cfg, globalTimeoutSec) {
  const port = typeof cfg.port_start === "number" ? Math.floor(cfg.port_start) : 11000;
  const startupTimeoutSec =
    typeof cfg.startup_timeout_sec === "number" && Number.isFinite(cfg.startup_timeout_sec)
      ? Math.max(1, Math.floor(cfg.startup_timeout_sec))
      : Math.max(1, Math.floor(globalTimeoutSec || 60));

  const logPath = `/tmp/tintin-mcp-${name}.log`;
  const pidPath = `/tmp/tintin-mcp-${name}.pid`;

  if (await canConnect(cfg.host, port)) {
    fail(`provider=${name} port already in use: ${cfg.host}:${port}`);
  }

  if (INSTALLED_PW_PACKAGE && INSTALLED_PW_PACKAGE !== cfg.package) {
    fail(
      `provider=${name} package mismatch: config=${cfg.package} image=${INSTALLED_PW_PACKAGE}. Rebuild the image or update config.`,
    );
  }

  const userDataDir = normalizeDir(cfg.user_data_dir, "/home/ubuntu/.tintin/playwright/profile", "user_data_dir");
  const outputDir = normalizeDir(cfg.output_dir, "/home/ubuntu/.tintin/playwright/artifacts", "output_dir");
  ensureDirSync(userDataDir);
  ensureDirSync(outputDir);

  const executablePath =
    typeof cfg.executable_path === "string" && cfg.executable_path.trim().length > 0 && fs.existsSync(cfg.executable_path)
      ? cfg.executable_path
      : undefined;
  if (cfg.executable_path && !executablePath) {
    log(`provider=${name} executable_path not found, ignoring: ${cfg.executable_path}`);
  }

  const cdpUrl = await discoverCdpUrl();
  if (!cdpUrl) {
    log(`provider=${name} CDP endpoint not ready; starting without --cdp-endpoint`);
  }

  const args = buildPlaywrightArgs(cfg, port, cdpUrl, userDataDir, outputDir, executablePath);
  const logFd = fs.openSync(logPath, "a");
  log(`provider=${name} starting MCP on ${cfg.host}:${port} (log=${logPath})`);
  const child = spawn("npx", args, { stdio: ["ignore", logFd, logFd], env: process.env });
  child.unref();
  fs.writeFileSync(pidPath, String(child.pid));

  try {
    await waitForPort(cfg.host, port, startupTimeoutSec * 1000);
    log(`provider=${name} ready on ${cfg.host}:${port}`);
  } catch (err) {
    try {
      child.kill("SIGTERM");
    } catch {
      // ignore
    }
    fail(`provider=${name} failed to start: ${String(err)}`);
  }
}

async function main() {
  const config = await readConfig();
  if (!config) {
    log("no MCP config provided; skipping");
    return;
  }
  if (!isRecord(config)) fail("MCP config must be an object");
  const providers = getProviders(config);
  const globalTimeoutSec =
    typeof config.global_timeout_sec === "number" && Number.isFinite(config.global_timeout_sec)
      ? Math.max(1, Math.floor(config.global_timeout_sec))
      : 60;

  const entries = Object.entries(providers);
  if (entries.length === 0) {
    log("no MCP providers configured; skipping");
    return;
  }

  let started = 0;
  for (const [name, provider] of entries) {
    if (!isRecord(provider)) continue;
    const enabled = provider.enabled !== false;
    if (!enabled) continue;
    if (provider.type !== "playwright") continue;
    const mode = typeof provider.provider === "string" ? provider.provider : "local";
    if (mode !== "local") {
      log(`provider=${name} mode=${mode} handled elsewhere; skipping`);
      continue;
    }
    const cfg = {
      package: typeof provider.package === "string" && provider.package ? provider.package : "@playwright/mcp@latest",
      host: typeof provider.host === "string" && provider.host ? provider.host : "127.0.0.1",
      port_start: provider.port_start,
      snapshot_mode: typeof provider.snapshot_mode === "string" ? provider.snapshot_mode : "full",
      image_responses: typeof provider.image_responses === "string" ? provider.image_responses : "allow",
      headless: provider.headless === true,
      user_data_dir: provider.user_data_dir,
      output_dir: provider.output_dir,
      executable_path: provider.executable_path,
      timeout_ms:
        typeof provider.timeout_ms === "number" && Number.isFinite(provider.timeout_ms) ? Math.floor(provider.timeout_ms) : 20_000,
      user_agent: provider.user_agent,
      viewport_size: provider.viewport_size,
      browser: typeof provider.browser === "string" && provider.browser ? provider.browser : "chrome",
      startup_timeout_sec: provider.startup_timeout_sec,
    };
    await startPlaywrightProvider(name, cfg, globalTimeoutSec);
    started += 1;
  }

  if (started === 0) {
    log("no local Playwright MCP providers enabled; skipping");
  }
}

main().catch((err) => fail(String(err)));
