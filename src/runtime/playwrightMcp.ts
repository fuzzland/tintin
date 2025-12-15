import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import net from "node:net";
import { access, mkdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { PlaywrightMcpSection } from "./config.js";
import type { Logger } from "./log.js";

export interface PlaywrightServerInfo {
  port: number;
  url: string;
  userDataDir: string;
  outputDir: string;
}

interface ScreenshotResult {
  savedPath?: string;
  mimeType?: string;
}

export class PlaywrightMcpManager {
  private startPromise: Promise<{ info: PlaywrightServerInfo; child: ChildProcessWithoutNullStreams }> | null = null;
  private clientPromise: Promise<Client> | null = null;

  constructor(private readonly config: PlaywrightMcpSection, private readonly logger: Logger) {}

  async ensureServer(): Promise<PlaywrightServerInfo> {
    if (this.startPromise) {
      const started = await this.startPromise;
      const healthy = await this.isServerHealthy(started.info).catch(() => false);
      if (healthy) return started.info;
      await this.stop().catch(() => undefined);
      this.startPromise = null;
      this.clientPromise = null;
    }
    this.startPromise = this.startServer().catch((e) => {
      this.startPromise = null;
      throw e;
    });
    const started = await this.startPromise;
    return started.info;
  }

  async stop(): Promise<void> {
    const client = this.clientPromise ? await this.clientPromise.catch(() => null) : null;
    if (client) {
      try {
        await client.close();
      } catch {
        // ignore
      }
    }
    const proc = this.startPromise ? await this.startPromise.catch(() => null) : null;
    if (proc?.child && !proc.child.killed) {
      proc.child.kill("SIGTERM");
      setTimeout(() => {
        if (!proc.child.killed) proc.child.kill("SIGKILL");
      }, 2_000);
    }
  }

  async takeScreenshot(opts: { sessionId: string; callId?: string; tool?: string }): Promise<ScreenshotResult | null> {
    const server = await this.ensureServer();
    const client = await this.ensureClient(server);
    const safeTool = opts.tool ? opts.tool.replace(/[^A-Za-z0-9_-]+/g, "-") : "call";
    const fileName = path.join(opts.sessionId, `${safeTool || "call"}-${opts.callId ?? "auto"}-${Date.now()}.png`);
    await mkdir(path.join(server.outputDir, path.dirname(fileName)), { recursive: true });
    try {
      const res = await client.callTool({
        name: "browser_take_screenshot",
        arguments: {
          filename: fileName,
        },
      });
      const imageBlock = Array.isArray(res.content) ? res.content.find((c: any) => c && typeof c === "object" && c.type === "image") : null;
      const savedPath = path.join(server.outputDir, fileName);
      return {
        savedPath,
        mimeType: typeof imageBlock?.mimeType === "string" ? imageBlock.mimeType : undefined,
      };
    } catch (e) {
      this.logger.debug(`[playwright-mcp] screenshot failed: ${String(e)}`);
      return null;
    }
  }

  private async ensureClient(server: PlaywrightServerInfo): Promise<Client> {
    if (this.clientPromise) return this.clientPromise;
    this.clientPromise = this.createClient(server);
    return this.clientPromise;
  }

  private async createClient(server: PlaywrightServerInfo): Promise<Client> {
    const client = new Client({ name: "tintin", version: "0.1.0" }, { capabilities: {} });
    const primary = new StreamableHTTPClientTransport(new URL(server.url));
    try {
      await client.connect(primary);
      return client;
    } catch (e) {
      this.logger.warn(`[playwright-mcp] streamable HTTP connect failed (${String(e)}), falling back to SSE`);
    }
    // Legacy SSE fallback: server advertises /sse for SSE transport
    const sseUrl = new URL(server.url);
    sseUrl.pathname = sseUrl.pathname.replace(/\/mcp$/, "") + "/sse";
    const fallback = new SSEClientTransport(sseUrl);
    await client.connect(fallback);
    return client;
  }

  private async isServerHealthy(info: PlaywrightServerInfo): Promise<boolean> {
    try {
      const res = await fetch(info.url, { method: "GET" });
      return res.ok;
    } catch {
      return false;
    }
  }

  private async startServer(): Promise<{ info: PlaywrightServerInfo; child: ChildProcessWithoutNullStreams }> {
    const userDataDir = substituteSessionId(this.config.user_data_dir, "shared");
    const outputDir = substituteSessionId(this.config.output_dir, "shared");
    await mkdir(userDataDir, { recursive: true });
    await mkdir(outputDir, { recursive: true });

    const port = await findAvailablePort(this.config.host, this.config.port_start, this.config.port_end);
    const executablePath = this.config.executable_path ?? (await findChromeExecutable()) ?? undefined;
    const args = buildPlaywrightArgs({
      pkg: this.config.package,
      host: this.config.host,
      port,
      browser: this.config.browser,
      userDataDir,
      outputDir,
      snapshotMode: this.config.snapshot_mode,
      imageResponses: this.config.image_responses,
      headless: this.config.headless,
      executablePath,
      timeoutMs: this.config.timeout_ms,
    });

    this.logger.info(`[playwright-mcp] starting on ${this.config.host}:${port}`);
    const child = spawn("npx", args, { stdio: ["pipe", "pipe", "pipe"] });
    child.stdout.on("data", (buf) => {
      const text = buf.toString("utf8").trim();
      if (text) this.logger.debug(`[playwright-mcp] ${text}`);
    });
    child.stderr.on("data", (buf) => {
      const text = buf.toString("utf8").trim();
      if (text) this.logger.warn(`[playwright-mcp] stderr: ${text}`);
    });
    child.on("exit", (code, signal) => {
      this.logger.warn(`[playwright-mcp] exited code=${String(code)} signal=${String(signal)}`);
      this.startPromise = null;
      this.clientPromise = null;
    });

    await waitForPortOpen(this.config.host, port, this.config.timeout_ms);
    const info: PlaywrightServerInfo = {
      port,
      url: `http://${this.config.host}:${port}/mcp`,
      userDataDir,
      outputDir,
    };
    return { info, child };
  }
}

function substituteSessionId(p: string, sessionId: string): string {
  return p.replaceAll("{sessionId}", sessionId);
}

async function findChromeExecutable(): Promise<string | null> {
  const candidates = [
    process.env.CHROME_PATH,
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ].filter((p): p is string => typeof p === "string" && p.length > 0);

  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

function buildPlaywrightArgs(opts: {
  pkg: string;
  host: string;
  port: number;
  browser: string;
  userDataDir: string;
  outputDir: string;
  snapshotMode: string;
  imageResponses: string;
  headless: boolean;
  executablePath?: string;
  timeoutMs: number;
  userAgent?: string;
  viewportSize?: string;
}): string[] {
  const args = [
    "-y",
    opts.pkg,
    "--browser",
    opts.browser,
    "--host",
    opts.host,
    "--port",
    String(opts.port),
    "--user-data-dir",
    opts.userDataDir,
    "--output-dir",
    opts.outputDir,
    "--snapshot-mode",
    opts.snapshotMode,
    "--image-responses",
    opts.imageResponses,
    "--shared-browser-context",
    "--timeout-navigation",
    String(Math.max(1_000, Math.min(opts.timeoutMs, 60_000))),
  ];
  if (opts.userAgent) args.push("--user-agent", opts.userAgent);
  if (opts.viewportSize) args.push("--viewport-size", opts.viewportSize);
  if (opts.executablePath) args.push("--executable-path", opts.executablePath);
  if (opts.headless) args.push("--headless");
  return args;
}

async function findAvailablePort(host: string, start: number, end: number): Promise<number> {
  for (let port = start; port <= end; port++) {
    const ok = await tryPort(host, port);
    if (ok) return port;
  }
  throw new Error(`No open port found for Playwright MCP between ${start} and ${end}`);
}

function tryPort(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.unref();
    srv.once("error", () => resolve(false));
    srv.listen(port, host, () => {
      srv.close(() => resolve(true));
    });
  });
}

async function waitForPortOpen(host: string, port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await canConnect(host, port);
    if (ok) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Timed out waiting for Playwright MCP on ${host}:${port}`);
}

function canConnect(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    socket.once("connect", () => {
      socket.end();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
    socket.setTimeout(1_000, () => {
      socket.destroy();
      resolve(false);
    });
  });
}
