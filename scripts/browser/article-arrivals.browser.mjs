import { test, expect } from "@playwright/test";
import { password } from "./fixture.mjs";

test.use({ video: "on" });

const artifacts = "/tmp/p2a-arrivals";
test("arrival badge clears only after the library loads", async ({
  page,
}, testInfo) => {
  await page.request.post("/login", {
    form: { username: "regression", password },
  });
  await page.route(/^https?:\/\/(?!127\.0\.0\.1:4317)/, (route) =>
    route.abort(),
  );
  let count = 0;
  await page.route("**/api/articles/arrivals", (route) =>
    route.fulfill({ json: { count } }),
  );
  await page.route("**/api/articles/visit", (route) => {
    count = 0;
    return route.fulfill({ status: 204 });
  });
  await page.goto("/");
  await expect(page.locator(".article-arrivals")).toBeHidden();
  await page.screenshot({
    path: `${artifacts}/${testInfo.project.name}-before.png`,
  });
  count = 2;
  await page.reload();
  const badge = page.locator(".article-arrivals");
  await expect(badge).toBeVisible();
  await expect(badge).toHaveText("2");
  await expect(badge).toHaveAttribute(
    "aria-label",
    "2 nieuwe artikelen uit gevolgde series",
  );
  await page.screenshot({
    path: `${artifacts}/${testInfo.project.name}-badge.png`,
  });
  await page.route("**/api/articles", (route) =>
    route.fulfill({ status: 500 }),
  );
  await page.locator('.main-nav a[href="/articles"]').click();
  await expect(page.locator("#articles-error")).not.toBeEmpty();
  await expect(badge).toBeVisible();
  await page.unroute("**/api/articles");
  await page.reload();
  await expect(badge).toBeHidden();
  await page.screenshot({
    path: `${artifacts}/${testInfo.project.name}-cleared.png`,
  });
});

test("series menu shows localized arrivals in dark mode", async ({
  page,
}, testInfo) => {
  await page.request.post("/login", {
    form: { username: "regression", password },
  });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.route("**/api/articles/arrivals", (route) =>
    route.fulfill({ json: { count: 12 } }),
  );
  await page.goto("/series");
  await expect(page.locator(".article-arrivals")).toHaveText("12");
  await page.screenshot({
    path: `${artifacts}/${testInfo.project.name}-dark-series.png`,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test("arrival endpoints require a session and validate visit timestamps", async ({
  request,
}) => {
  expect((await request.get("/api/articles/arrivals")).status()).toBe(401);
  expect(
    (
      await request.post("/api/articles/visit", {
        data: { visitedAt: new Date().toISOString() },
      })
    ).status(),
  ).toBe(401);
  await request.post("/login", { form: { username: "regression", password } });
  expect(
    (
      await request.post("/api/articles/visit", {
        data: { visitedAt: "invalid" },
      })
    ).status(),
  ).toBe(400);
  expect(
    (
      await request.post("/api/articles/visit", {
        data: { visitedAt: "2999-01-01T00:00:00.000Z" },
      })
    ).status(),
  ).toBe(400);
  const articles = await request.get("/api/articles");
  expect(
    (
      await request.post("/api/articles/visit", {
        data: { visitedAt: articles.headers()["x-articles-snapshot"] },
      })
    ).status(),
  ).toBe(204);
  expect(await (await request.get("/api/articles/arrivals")).json()).toEqual({
    count: 0,
  });
});
