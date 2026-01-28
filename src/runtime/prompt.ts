import { t, type UserLanguage } from "../locales/index.js";

export function buildLocalizedPrompt(
  prompt: string,
  lang: UserLanguage,
  opts?: { searchDirective?: string | null },
): string {
  const directives: string[] = [];
  const languageDirective = t("prompt.language_directive", lang);
  if (languageDirective) directives.push(languageDirective);
  const searchDirective = opts?.searchDirective;
  if (searchDirective) directives.push(searchDirective);
  const directive = directives.join("\n");
  const base = typeof prompt === "string" ? prompt : "";
  if (!base.trim()) return directive;
  return `${directive}\n\n${base}`;
}
