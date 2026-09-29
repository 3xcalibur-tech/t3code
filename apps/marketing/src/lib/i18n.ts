import { getTranslationsSnapshot, initializeGT } from "gt-react";
import gtConfig from "../../gt.config.json";
import englishSite from "../i18n/en/site.json";

export const locales = [
  { code: "en", name: "English", href: "/" },
  { code: "es", name: "Español", href: "/es/" },
  { code: "pt-BR", name: "Português (Brasil)", href: "/pt-BR/" },
  { code: "de", name: "Deutsch", href: "/de/" },
  { code: "ja", name: "日本語", href: "/ja/" },
  { code: "zh-CN", name: "简体中文", href: "/zh-CN/" },
] as const;

export type Locale = (typeof locales)[number]["code"];

export const localePath = (locale: Locale) => (locale === "en" ? "/" : `/${locale}/`);

const siteStrings = import.meta.glob<typeof englishSite>("../i18n/*/site.json", {
  eager: true,
  import: "default",
});

export function getSiteStrings(locale: Locale) {
  const strings = siteStrings[`../i18n/${locale}/site.json`];
  if (!strings) throw new Error(`Missing homepage strings for ${locale}. Run i18n:translate.`);
  for (const key of Object.keys(englishSite) as (keyof typeof englishSite)[]) {
    if (!strings[key]) throw new Error(`Missing ${locale} homepage string: ${key}`);
  }
  return strings;
}

const catalogs = import.meta.glob<Record<string, unknown>>("../_gt/*.json", {
  eager: true,
  import: "default",
});

// All locales render at build time. Missing catalogs must fail the build instead
// of publishing an English page under a translated URL or fetching a CDN at runtime.
initializeGT({
  defaultLocale: gtConfig.defaultLocale,
  locales: gtConfig.locales,
  cacheUrl: null,
  loadTranslations: async (locale) => {
    if (locale === gtConfig.defaultLocale) return {};
    const catalog = catalogs[`../_gt/${locale}.json`];
    if (!catalog)
      throw new Error(`Missing homepage translations for ${locale}. Run i18n:translate.`);
    return catalog;
  },
});

export function getHomepageTranslations(locale: Locale) {
  if (locale !== gtConfig.defaultLocale && !catalogs[`../_gt/${locale}.json`]) {
    throw new Error(`Missing homepage translations for ${locale}. Run i18n:translate.`);
  }
  return getTranslationsSnapshot(locale);
}
