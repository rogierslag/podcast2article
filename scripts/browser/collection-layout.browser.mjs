import { test, expect } from "@playwright/test";
import { password } from "./fixture.mjs";

test.use({ video: "on" });

test("Articles and Series preserve the library layout when switching views", async ({
  page,
}, testInfo) => {
  // Keep both navigations on the same fallback fonts, independent of the CDN.
  await page.route(/^https?:\/\/(?!127\.0\.0\.1:4317)/, (route) =>
    route.abort(),
  );
  await page.request.post("/login", {
    form: { username: "regression", password },
  });
  await page.route("**/api/subscriptions", (route) =>
    route.fulfill({
      json: [
        {
          id: "00000000-0000-4000-8000-000000000771",
          title: "De wetenschap van alledag",
          paused: false,
          complete: 4,
          processing: 0,
          outstanding: 4,
          pendingCount: 0,
          failed: [],
        },
      ],
    }),
  );
  await page.goto("/articles");
  await expect(page.locator(".article-card").first()).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  const articlesHeading = await page
    .locator(".collection-heading")
    .boundingBox();
  const articlesTitleBounds = await page
    .locator(".collection-heading h1")
    .boundingBox();
  const articlesTitle = await page
    .locator(".collection-heading h1")
    .evaluate((title) => getComputedStyle(title).font);
  await expect(
    page.locator('.main-nav a[aria-current="page"]'),
  ).toHaveAttribute("href", "/articles");
  await page.screenshot({
    path: `/tmp/p2a-unified-${testInfo.project.name}-articles.png`,
    fullPage: true,
  });

  await page.locator('.main-nav a[href="/series"]').click();
  await expect(page.locator(".series-item")).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  const seriesHeading = await page.locator(".collection-heading").boundingBox();
  for (const dimension of ["x", "y", "width"]) {
    expect(
      Math.abs(seriesHeading[dimension] - articlesHeading[dimension]),
    ).toBeLessThan(1);
  }
  const seriesTitleBounds = await page
    .locator(".collection-heading h1")
    .boundingBox();
  // Different title lengths may wrap; the spacing around them must still match.
  expect(
    Math.abs(
      seriesHeading.height -
        seriesTitleBounds.height -
        (articlesHeading.height - articlesTitleBounds.height),
    ),
  ).toBeLessThan(1);
  expect(
    await page
      .locator(".collection-heading h1")
      .evaluate((title) => getComputedStyle(title).font),
  ).toBe(articlesTitle);
  await expect(
    page.locator('.main-nav a[aria-current="page"]'),
  ).toHaveAttribute("href", "/series");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: `/tmp/p2a-unified-${testInfo.project.name}-series.png`,
    fullPage: true,
  });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.screenshot({
    path: `/tmp/p2a-unified-${testInfo.project.name}-series-dark.png`,
    fullPage: true,
  });
  await page.locator('.main-nav a[href="/articles"]').click();
  await expect(page.locator(".article-card").first()).toBeVisible();
  await expect(
    page.locator('.main-nav a[aria-current="page"]'),
  ).toHaveAttribute("href", "/articles");
});

test("page containers share desktop edges while article text stays readable", async ({
  page,
}, testInfo) => {
  const { articleId, token } = await import("./fixture.mjs");
  await page.request.post("/login", {
    form: { username: "regression", password },
  });
  await page.route("**/api/subscriptions", (route) =>
    route.fulfill({ json: [] }),
  );
  const initialWidth = page.viewportSize().width;
  for (const width of [...new Set([initialWidth, 1440, 1920])]) {
    await page.setViewportSize({ width, height: width <= 600 ? 844 : 1000 });
    let expectedEdges;
    for (const [name, url, selector] of [
      ["landing", "/", ".landing"],
      ["articles", "/articles", ".collection-page"],
      ["series", "/series", ".collection-page"],
      ["reader", `/#job=${articleId}`, ".content-layout"],
      ["shared", `/s/${token}`, ".content-layout"],
    ]) {
      await page.goto(url);
      await expect(page.locator(selector)).toBeVisible();
      const edges = await page.locator(selector).evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return [
          bounds.left + parseFloat(style.paddingLeft),
          bounds.right - parseFloat(style.paddingRight),
        ];
      });
      expectedEdges ??= edges;
      for (const index of [0, 1]) {
        expect(Math.abs(edges[index] - expectedEdges[index])).toBeLessThan(2);
      }
      const headerEdges = await page.locator(".nav").evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return [
          bounds.left + parseFloat(style.paddingLeft),
          bounds.right - parseFloat(style.paddingRight),
        ];
      });
      for (const index of [0, 1]) {
        expect(Math.abs(headerEdges[index] - edges[index])).toBeLessThan(2);
      }
      if (["reader", "shared"].includes(name)) {
        expect(
          (await page.locator("#article").boundingBox()).width,
        ).toBeLessThanOrEqual(760);
      }
      if (width === initialWidth) {
        await page.screenshot({
          path: `/tmp/p2a-container-${testInfo.project.name}-${name}.png`,
        });
      }
    }
  }
});
