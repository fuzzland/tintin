import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { UserLanguage } from "../../locales/index.js";
import { t } from "../../locales/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface PromptFile {
  filename: string;
  content: string;
}

/**
 * Load all .md files from the prompts/ directory.
 * Returns files sorted alphabetically by filename.
 */
export async function loadAllPrompts(): Promise<PromptFile[]> {
  // Resolve prompts/ directory from dist/src/runtime/cloud/prompts.js
  // Go up 4 levels (cloud -> runtime -> src -> dist -> root), then into prompts/
  const promptsDir = join(__dirname, "../../../../prompts");

  const prompts: PromptFile[] = [];

  try {
    const entries = await readdir(promptsDir, { withFileTypes: true });
    const mdFiles = entries
      .filter((e) => e.isFile() && e.name.endsWith(".md"))
      .map((e) => e.name)
      .sort(); // Alphabetical order

    for (const filename of mdFiles) {
      const filePath = join(promptsDir, filename);
      const content = await readFile(filePath, "utf-8");
      prompts.push({ filename, content });
    }
  } catch (e) {
    // If prompts/ doesn't exist or can't be read, return empty array
    console.warn(`[prompts] could not load prompts: ${String(e)}`);
  }

  return prompts;
}

/**
 * Load the root AGENTS.md file.
 */
export async function loadRootAgentsMd(): Promise<string> {
  const agentsPath = join(__dirname, "../../../../AGENTS.md");
  try {
    return await readFile(agentsPath, "utf-8");
  } catch (e) {
    console.warn(`[prompts] could not load AGENTS.md: ${String(e)}`);
    return "";
  }
}

/**
 * Build the complete AGENTS.md content for the remote sandbox.
 * Combines: root AGENTS.md + prompts/*.md + locale directive
 */
export async function buildAgentsMdContent(language: UserLanguage): Promise<string> {
  const parts: string[] = [];

  // 1. Root AGENTS.md
  const rootAgentsMd = await loadRootAgentsMd();
  if (rootAgentsMd) {
    parts.push(rootAgentsMd);
  }

  // 2. All prompts from prompts/ directory
  const prompts = await loadAllPrompts();
  for (const prompt of prompts) {
    if (parts.length > 0) parts.push("\n\n---\n\n");
    parts.push(`## From: prompts/${prompt.filename}\n\n`);
    parts.push(prompt.content);
  }

  // 3. Locale directive (always include, including English)
  const localeDirective = t("prompt.language_directive", language);
  if (localeDirective) {
    parts.push(`\n\n---\n\n## Language Directive\n\n${localeDirective}\n`);
  }

  return parts.join("");
}
