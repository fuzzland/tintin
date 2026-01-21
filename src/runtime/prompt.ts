import { t, type UserLanguage } from "../locales/index.js";

export function buildLocalizedPrompt(prompt: string, lang: UserLanguage): string {
  const directive = t("prompt.language_directive", lang);
  const base = typeof prompt === "string" ? prompt : "";
  if (!base.trim()) return directive;
  return `${directive}\n\n${base}`;
}
