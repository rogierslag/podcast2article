import {
  countLabel,
  dateLocale,
  translate,
  uiLanguage,
  preferredUiLanguage,
  UI_LANGUAGE_COOKIE,
} from "../src/shared/i18n.js";

export const language =
  preferredUiLanguage(document.cookie) ??
  uiLanguage(navigator.language || navigator.languages?.[0]);
export const locale = dateLocale(language);
export const t = (key: string, values?: Record<string, string | number>) =>
  translate(language, key, values);
export const countText = (key: string, count: number) =>
  countLabel(language, key, count);

export function localizePage(root: ParentNode = document) {
  document.documentElement.lang = language;
  root.querySelectorAll<HTMLElement>("[data-i18n]").forEach((element) => {
    element.textContent = t(element.dataset.i18n ?? "");
  });
  for (const attribute of [
    "aria-label",
    "aria-valuetext",
    "placeholder",
    "content",
    "title",
  ]) {
    root.querySelectorAll(`[data-i18n-${attribute}]`).forEach((element) => {
      element.setAttribute(
        attribute,
        t(element.getAttribute(`data-i18n-${attribute}`) ?? ""),
      );
    });
  }
  root.querySelectorAll<HTMLElement>("[data-build-sha]").forEach((element) => {
    const sha = element.dataset.buildSha ?? "";
    element.textContent = t("build", { sha: sha.slice(0, 7) });
    element.setAttribute("title", t("build.label", { sha }));
  });
}

export class LocalizedError extends Error {}

export function errorText(error: unknown) {
  if (error instanceof LocalizedError) {
    return error.message;
  }
  return t(error instanceof TypeError ? "error.network" : "error.generic");
}

export function localizedFetch(
  input: RequestInfo | URL,
  options: RequestInit = {},
) {
  const headers = new Headers(options.headers);
  headers.set("Accept-Language", language);
  return window.fetch(input, { ...options, headers });
}

localizePage();

document
  .querySelectorAll<HTMLElement>("[data-ui-language]")
  .forEach((button) => {
    const selectedLanguage = button.dataset.uiLanguage;
    button.setAttribute("aria-pressed", String(selectedLanguage === language));
    button.addEventListener("click", () => {
      if (selectedLanguage !== "nl" && selectedLanguage !== "en") {
        return;
      }
      const secure = location.protocol === "https:" ? "; Secure" : "";
      document.cookie = `${UI_LANGUAGE_COOKIE}=${selectedLanguage}; Path=/; Max-Age=31536000; SameSite=Lax${secure}`;
      if (selectedLanguage !== language) {
        // Reload the current route so dynamic content and API messages switch too.
        location.reload();
      }
    });
  });
