import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { parseSetupSpec, type SetupSpec } from "./setupSpec.js";

async function exists(p: string): Promise<boolean> {
  try {
    const st = await stat(p);
    return st.isFile();
  } catch {
    return false;
  }
}

function parseEnvExample(text: string): string[] {
  const vars: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    if (!/^[A-Z0-9_]+$/i.test(key)) continue;
    if (!vars.includes(key)) vars.push(key);
  }
  return vars;
}

export async function generateSetupSpecFromPath(repoPath: string): Promise<SetupSpec> {
  const spec: SetupSpec = { version: 1, provider: "cloud" };
  const commands: string[] = [];
  const files: Array<{ path: string; mode?: string; content?: string }> = [];
  const envVars: string[] = [];

  const pkgJsonPath = path.join(repoPath, "package.json");
  if (await exists(pkgJsonPath)) {
    const raw = await readFile(pkgJsonPath, "utf8");
    const pkg = JSON.parse(raw) as any;
    const hasPnpm = await exists(path.join(repoPath, "pnpm-lock.yaml"));
    const hasBun = await exists(path.join(repoPath, "bun.lockb")) || await exists(path.join(repoPath, "bun.lock"));
    if (hasBun) commands.push("bun install");
    else if (hasPnpm) commands.push("pnpm install");
    else commands.push("npm ci");
    if (pkg?.scripts?.build) commands.push("npm run build");
  }

  if (await exists(path.join(repoPath, "requirements.txt"))) {
    commands.push("python -m pip install -r requirements.txt");
  } else if (await exists(path.join(repoPath, "pyproject.toml"))) {
    commands.push("python -m pip install -e .");
  }

  if (await exists(path.join(repoPath, "go.mod"))) {
    commands.push("go mod download");
  }

  if (await exists(path.join(repoPath, "Cargo.toml"))) {
    commands.push("cargo build");
  }

  const envExamplePath = path.join(repoPath, ".env.example");
  if (await exists(envExamplePath)) {
    const content = await readFile(envExamplePath, "utf8");
    envVars.push(...parseEnvExample(content));
    files.push({ path: ".env.example" });
  }

  if (envVars.length > 0) {
    spec.env = envVars.map((name) => ({ name, value: `%${name}%` }));
  }
  if (files.length > 0) spec.files = files;
  if (commands.length > 0) spec.commands = commands;

  return spec;
}

export async function loadExistingSetupSpec(repoPath: string): Promise<SetupSpec | null> {
  const specPath = path.join(repoPath, "tintin-setup.yml");
  if (!(await exists(specPath))) return null;
  const text = await readFile(specPath, "utf8");
  return parseSetupSpec(text);
}
