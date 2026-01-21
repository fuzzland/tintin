import { en } from "./en.js";
import { zh } from "./zh.js";

export type UserLanguage = "en" | "zh";
export type TranslationKey = keyof typeof en;

const translations: Record<UserLanguage, Record<string, string>> = { en, zh };

export function t(
  key: TranslationKey,
  locale: UserLanguage,
  params?: Record<string, string | number>,
): string {
  let text = translations[locale]?.[key] ?? translations.en[key] ?? key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      text = text.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
    }
  }
  return text;
}

export function getOtherLanguage(lang: UserLanguage): UserLanguage {
  return lang === "en" ? "zh" : "en";
}

export function getLanguageLabel(lang: UserLanguage): string {
  return lang === "zh" ? "🇨🇳 中文" : "🇬🇧 English";
}

export function isUserLanguage(value: string): value is UserLanguage {
  return value === "en" || value === "zh";
}
