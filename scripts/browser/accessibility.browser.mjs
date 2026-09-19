import { test, expect } from "@playwright/test";
import { articleFixture, articleId, password, token } from "./fixture.mjs";
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
      await expect(
        page.locator(".article-card-placeholder"),
      ).toHaveAccessibleName(
        translate(language, "article.read", {
          title: `01: ${job.article.title}`,
        }),
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
      await expect(page.locator(".build-sha")).not.toHaveAttribute(
        "aria-label",
      );
      await expect(page.locator(".build-sha")).toHaveAttribute(
        "title",
        translate(language, "build.label", {
          sha: "1234567890123456789012345678901234567890",
        }),
      );
    });
    test(`${language} ${colorScheme}: owner and shared resume actions name their visible label and destination`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme });
      await page.route(/^https?:\/\/(?!127\.0\.0\.1:4317)/, (route) =>
        route.abort(),
      );
      await page.context().addCookies([
        {
          name: "p2a_ui_language",
          value: language,
          url: "http://127.0.0.1:4317",
        },
      ]);
      await page.request.post("/login", {
        form: { username: "regression", password },
      });
      const job = articleFixture();
      job.readingPosition = {
        sectionIndex: 1,
        updatedAt: "2026-09-19T10:00:00Z",
      };
      await page.route(`**/api/jobs/${articleId}`, (route) =>
        route.fulfill({ json: job }),
      );
      await page.goto(`/#job=${articleId}`);
      const resume = page.locator("#continue-reading");
      const heading = job.article.sections[1].heading;

      await expect(resume).toHaveAccessibleName(
        `${translate(language, "readingPosition.resume")} ${heading}`,
      );
      await resume.focus();
      await page.keyboard.press("Enter");

      await expect(
        page.getByRole("heading", { name: heading, exact: true }),
      ).toBeFocused();

      await page.evaluate(
        (token) =>
          localStorage.setItem(
            `podcast2article:reading-position:${token}`,
            JSON.stringify({ sectionIndex: 1 }),
          ),
        token,
      );
      await page.goto(`/s/${token}`);

      await expect(resume).toHaveAccessibleName(
        `${translate(language, "readingPosition.resume")} ${heading}`,
      );
      await resume.focus();
      await page.keyboard.press("Enter");

      await expect(
        page.getByRole("heading", { name: heading, exact: true }),
      ).toBeFocused();
    });
    test(`${language} ${colorScheme}: enlarged text spacing fits a 320px viewport`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 320, height: 844 });
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
      await page.route(`**/api/jobs/${articleId}`, (route) =>
        route.fulfill({ json: articleFixture() }),
      );

      for (const [url, selector] of [
        ["/login", "#username"],
        ["/", "#source-url"],
        ["/articles", "#articles-view"],
        [`/#job=${articleId}`, "#article > h1"],
      ]) {
        await page.goto(url);
        await expect(page.locator(selector)).toBeVisible();
        await page.addStyleTag({
          content: `
            * {
              line-height: 1.5 !important;
              letter-spacing: 0.12em !important;
              word-spacing: 0.16em !important;
            }
            p { margin-bottom: 2em !important; }
          `,
        });

        await expect
          .poll(() =>
            page.evaluate(
              () => document.documentElement.scrollWidth <= innerWidth,
            ),
          )
          .toBe(true);

        if (url === "/login") {
          await page.request.post("/login", {
            form: { username: "regression", password },
          });
        }
      }
    });
  }
}
