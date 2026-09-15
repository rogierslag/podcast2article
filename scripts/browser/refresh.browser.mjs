import { test, expect } from "@playwright/test";
import { articleId, password } from "./fixture.mjs";

function holdRequest(page, pattern) {
  const requested = Promise.withResolvers();
  const released = Promise.withResolvers();
  const installed = page.route(pattern, async (route) => {
    requested.resolve();
    await released.promise;
    await route.continue();
  });
  return { installed, requested: requested.promise, release: released.resolve };
}

async function observeLanding(page) {
  await page.addInitScript(() => {
    window.landingWasVisible = false;
    function inspectFrame() {
      const landing = document.querySelector("#landing");
      if (landing?.getClientRects().length) {
        window.landingWasVisible = true;
      }
      requestAnimationFrame(inspectFrame);
    }
    requestAnimationFrame(inspectFrame);
  });
}

test.beforeEach(async ({ page }) => {
  await page.route(/^https?:\/\/(?!127\.0\.0\.1:4317)/, (route) =>
    route.abort(),
  );
  const response = await page.request.post("/login", {
    form: { username: "regression", password },
  });
  expect(response.ok()).toBeTruthy();
});

for (const [name, url, api, ready] of [
  [
    "article",
    `/#job=${articleId}`,
    `**/api/jobs/${articleId}`,
    "#article > h1",
  ],
  ["overview", "/articles", "**/api/articles", ".article-card"],
]) {
  test(`${name}: refreshing never paints the landing page while scripts or data load`, async ({
    page,
  }) => {
    await page.goto(url);
    await expect(page.locator(ready).first()).toBeVisible();
    await observeLanding(page);
    const script = holdRequest(page, "**/app.js?*");
    const data = holdRequest(page, api);
    await Promise.all([script.installed, data.installed]);

    await page.reload({ waitUntil: "commit" });
    await script.requested;
    await expect(page.locator(".nav")).toBeVisible();
    await expect(page.locator("#landing")).toBeHidden();
    await expect(
      page
        .getByRole("status", { name: "" })
        .filter({ hasText: "Pagina laden…" }),
    ).toBeVisible();
    await expect(page.locator("#initial-loading p")).toBeVisible();
    script.release();
    await data.requested;
    await expect(page.locator("#landing")).toBeHidden();
    await expect(page.locator("#initial-loading")).toBeVisible();
    data.release();

    await expect(page.locator(ready).first()).toBeVisible();
    await expect(page.locator("#initial-loading")).toBeHidden();
    expect(await page.evaluate(() => window.landingWasVisible)).toBe(false);
  });

  test(`${name}: an API failure reveals the existing error instead of leaving the loading shell`, async ({
    page,
  }) => {
    await page.route(api, (route) =>
      route.fulfill({ status: 503, json: { error: "Unavailable" } }),
    );

    await page.goto(url);

    const error = page.locator(
      name === "article" ? "#form-error" : "#articles-error",
    );
    await expect(error).toBeVisible();
    await expect(error).not.toHaveText("");
    await expect(page.locator("#initial-loading")).toBeHidden();
  });
}

for (const url of ["/", "/#job=invalid", "/#job=", "/#unrelated=value"]) {
  test(`landing route ${url} remains usable`, async ({ page }) => {
    await page.goto(url);

    await expect(page.locator("#source-url")).toBeVisible();
    await expect(page.locator("#initial-loading")).toBeHidden();
    await page.locator("#source-url").focus();
    await expect(page.locator("#source-url")).toBeFocused();
  });
}

test("leaving the initial overview while its request is pending keeps the article loading shell", async ({
  page,
}) => {
  const overview = holdRequest(page, "**/api/articles");
  const article = holdRequest(page, `**/api/jobs/${articleId}`);
  await Promise.all([overview.installed, article.installed]);
  await observeLanding(page);
  await page.goto("/articles");
  await overview.requested;

  await page.evaluate((id) => {
    location.hash = `job=${id}`;
  }, articleId);
  await article.requested;
  const oldResponse = page.waitForResponse("**/api/articles");
  overview.release();
  await oldResponse;
  // Let the stale response's continuation run before checking the new route.
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  await expect(page.locator("#initial-loading")).toBeVisible();
  await expect(page.locator("#articles-view")).toBeHidden();
  article.release();

  await expect(page.locator("#article > h1")).toBeVisible();
  await expect(page.locator("#initial-loading")).toBeHidden();
  expect(await page.evaluate(() => window.landingWasVisible)).toBe(false);
});
