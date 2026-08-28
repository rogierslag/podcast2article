export type UiLanguage = "nl" | "en";
export const messages: Record<string, Record<UiLanguage, string>>;
export const UI_LANGUAGE_COOKIE: string;
export function preferredUiLanguage(
  cookieHeader?: string,
): UiLanguage | undefined;
export function uiLanguage(language?: string): UiLanguage;
export function translate(
  language: string,
  key: string,
  values?: Record<string, string | number>,
): string;
export function countLabel(
  language: string,
  key: string,
  count: number,
): string;
export function dateLocale(language: string): string;
