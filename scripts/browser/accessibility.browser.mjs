import { test, expect } from "@playwright/test";
import { articleFixture, articleId, password } from "./fixture.mjs";
import { translate } from "../../public/i18n.js";

for (const language of ["nl", "en"]) {
  for (const colorScheme of ["light", "dark"]) {
    test(`${language} ${colorScheme}: action names retain their labels through read, loading and error states`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme });
      await page.context().addCookies([
        {
          name: "p2a_ui_language",
          value: language,
          url: "http://127.0.0.1:4317",
        },
      ]);
      await page.route(/^https?:\/\/(?!127\.0\.0\.1:4317)/, (route) =>
        route.abort(),
      );
      await page.request.post("/login", {
        form: { username: "regression", password },
      });
      const job = articleFixture();
      await page.route(`**/api/jobs/${articleId}`, (route) =>
        route.fulfill({ json: job }),
      );
      await page.goto(`/#job=${articleId}`);
      const read = page.locator("[data-article-read-toggle]");
      const t = (key) => translate(language, key);
      for (const [selector, key] of [
        ["[data-share-article]", "article.copyLink"],
        ["[data-pdf-export]", "article.downloadPdf"],
        ["[data-article-read-toggle]", "article.markRead"],
      ]) {
        const buttons = page.locator(selector);
        await expect(buttons).toHaveCount(2);
        for (const button of await buttons.all()) {
          await expect(button).toHaveAccessibleName(t(key));
          await expect(button.locator("span")).toHaveText(t(key));
        }
      }
      let release;
      await page.route(`**/api/articles/${articleId}`, async (route) => {
        await new Promise((resolve) => {
          release = resolve;
        });
        await route.fulfill({
          json: { id: articleId, readAt: "2026-09-19T10:00:00Z" },
        });
      });
      await read.first().click();
      await expect(read.first()).toBeDisabled();
      await expect(read.last()).toBeDisabled();
      await expect(read.first()).toHaveAccessibleName(t("article.markRead"));
      await expect.poll(() => Boolean(release)).toBe(true);
      release();
      for (const button of await read.all()) {
        await expect(button).toBeEnabled();
        await expect(button).toHaveAttribute("aria-pressed", "true");
        await expect(button).toHaveAccessibleName(t("article.markUnreadLabel"));
        expect(t("article.markUnreadLabel")).toContain(
          await button.innerText(),
        );
      }
      await page.route(`**/api/articles/${articleId}`, (route) =>
        route.fulfill({ status: 500, json: { error: "Opslaan mislukt" } }),
      );
      await read.first().click();
      await expect(page.locator("#article-action-status")).toHaveText(
        "Opslaan mislukt",
      );
      await expect(read.first()).toBeEnabled();
      await expect(read.first()).toHaveAccessibleName(
        t("article.markUnreadLabel"),
      );
      await page.route(`**/api/articles/${articleId}`, (route) =>
        route.fulfill({ json: { id: articleId } }),
      );
      await read.first().click();
      await expect(read.first()).toHaveAttribute("aria-pressed", "false");
      await expect(read.first()).toHaveAccessibleName(t("article.markRead"));

      await page.route("**/api/articles", (route) =>
        route.fulfill({
          json: [
            {
              id: articleId,
              title: job.article.title,
              sourceName: job.episode.sourceName,
              sourceType: "google-drive",
              completedAt: job.completedAt,
              readingTimeMinutes: 5,
              readAt: "2026-09-19T10:00:00Z",
            },
          ],
        }),
      );
      await page.goto("/articles");
      await page.locator("details.article-shelf summary").click();
      await expect(page.locator("[data-read-toggle]")).toHaveAccessibleName(
        t("article.markUnreadLabel"),
      );
    });
    test(`${language} ${colorScheme}: login version text keeps full contrast`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme });
      await page.context().addCookies([
        {
          name: "p2a_ui_language",
          value: language,
          url: "http://127.0.0.1:4317",
        },
      ]);
      await page.goto("/login");
      await expect(page.locator(".build-sha")).toBeVisible();
      await expect(page.locator(".build-sha")).toHaveCSS("opacity", "1");
    });
  }
}
