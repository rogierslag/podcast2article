import { test, expect } from "@playwright/test";
import { password } from "./fixture.mjs";

test("overview shows the publication below each title instead of the platform", async ({
  page,
}, testInfo) => {
  await page.route(/^https?:\/\/(?!127\.0\.0\.1:4317)/, (route) =>
    route.abort(),
  );
  await page.request.post("/login", {
    form: { username: "regression", password },
  });
  const articles = [
    {
      id: "science",
      title: "Waarom ons geheugen meer doet dan herinneringen bewaren",
      sourceName: "De wetenschap van alledag",
      sourceType: "spotify",
      dek: "Ons geheugen legt verbanden tussen wat we weten en wat we nog moeten ontdekken.",
    },
    {
      id: "history",
      title: "Wat oude steden ons vertellen over het leven van nu",
      sourceName:
        "Geschiedenis voor onderweg — verhalen over mensen en hun omgeving",
      sourceType: "rss",
      dek: "Achter straten en gebouwen schuilen keuzes die nog steeds bepalen hoe we samenleven.",
    },
    {
      id: "unsafe",
      title: "Een andere kijk op technologie",
      sourceName: '<img src=x onerror="window.injected=true">',
      sourceType: "youtube",
      dek: "Een gesprek over de invloed van techniek op ons dagelijks leven.",
      readAt: "2026-09-19T10:00:00Z",
    },
  ];
  await page.route("**/api/articles", (route) =>
    route.fulfill({
      json: articles.map((article) => ({
        ...article,
        completedAt: "2026-09-18T10:00:00Z",
        publishedAt: "2026-09-16T10:00:00Z",
        readingTimeMinutes: 6,
      })),
    }),
  );
  await page.goto("/articles");
  const cards = page.locator(".article-card");
  await expect(cards).toHaveCount(3);
  await expect(cards.first().locator(".article-card-meta")).toHaveText(
    "16 september 2026 · 6 min.",
  );
  await expect(
    cards.first().locator(".article-card-title + .article-card-publication"),
  ).toHaveText(articles[0].sourceName);
  await expect(cards.first()).not.toContainText("Spotify");
  await expect(cards.first().locator(".article-card-footer")).not.toContainText(
    articles[0].sourceName,
  );
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    )
    .toBe(true);
  await page.screenshot({
    path: `/tmp/p2a-publication-${testInfo.project.name}.png`,
    fullPage: true,
  });
  await page.locator("details.article-shelf summary").click();
  await expect(cards.last().locator(".article-card-publication")).toHaveText(
    articles[2].sourceName,
  );
  await expect(
    cards.last().locator(".article-card-publication img"),
  ).toHaveCount(0);
  expect(await page.evaluate(() => window.injected)).toBeUndefined();
  await page.locator("details.article-shelf summary").click();
  await page.emulateMedia({ colorScheme: "dark" });
  await page.reload();
  await expect(page.locator(".article-card-publication").first()).toBeVisible();
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  await page.screenshot({
    path: `/tmp/p2a-publication-${testInfo.project.name}-dark.png`,
    fullPage: true,
  });
});
