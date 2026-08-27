import { countLabel, dateLocale, translate, uiLanguage } from "./i18n.js";

export const language = uiLanguage(
  navigator.language || navigator.languages?.[0],
);
export const locale = dateLocale(language);
export const t = (key, values) => translate(language, key, values);
export const countText = (key, count) => countLabel(language, key, count);

export function localizePage(root = document) {
  document.documentElement.lang = language;
  root.querySelectorAll("[data-i18n]").forEach((element) => {
    element.textContent = t(element.dataset.i18n);
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
        t(element.getAttribute(`data-i18n-${attribute}`)),
      );
    });
  }
  root.querySelectorAll("[data-build-sha]").forEach((element) => {
    const sha = element.dataset.buildSha;
    element.textContent = t("build", { sha: sha.slice(0, 7) });
    element.setAttribute("aria-label", t("build.label", { sha }));
  });
}

export class LocalizedError extends Error {}

export function errorText(error) {
  if (error instanceof LocalizedError) {
    return error.message;
  }
  return t(error instanceof TypeError ? "error.network" : "error.generic");
}

export function localizedFetch(input, options = {}) {
  const headers = new Headers(options.headers);
  headers.set("Accept-Language", language);
  return window.fetch(input, { ...options, headers });
}

localizePage();
