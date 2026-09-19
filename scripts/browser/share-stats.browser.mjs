import { test, expect } from "@playwright/test";
import { articleId, password, token, articleFixture } from "./fixture.mjs";

async function openArticle(page) {
  await page.request.post("/login", {
    form: { username: "regression", password },
  });
  await page.goto(`/#job=${articleId}`);
  await expect(page.locator("#article > h1")).toBeVisible();
}

for (const language of ["en", "nl"]) {
  test(`footer statistics show counts only below the article (${language})`, async ({
    page,
  }, testInfo) => {
    await page.addInitScript((language) => {
      Object.defineProperty(navigator, "language", { get: () => language });
      Object.defineProperty(navigator, "languages", { get: () => [language] });
    }, language);
    await page.route(`**/api/jobs/${articleId}/share-stats`, (route) =>
      route.fulfill({ json: { loads: 124, reads: 37 } }),
    );
    await openArticle(page);

    const stats = page.locator(".article-share-stats");
    await expect(stats).toHaveCount(1);
    await expect(page.locator("#share-stats-loads")).toHaveText("124");
    await expect(page.locator("#share-stats-reads")).toHaveText("37");
    await expect(page.locator("#share-stats-note")).toContainText(
      language === "en"
        ? "Reading in your own library does not count"
        : "Lezen in je eigen bibliotheek telt niet mee",
    );
    await expect(page.locator("#share-stats-heading")).toHaveText(
      language === "en"
        ? "Shared link activity"
        : "Activiteit via gedeelde link",
    );
    expect(
      await stats.evaluate((element) =>
        Boolean(
          document.querySelector("#article").compareDocumentPosition(element) &
          Node.DOCUMENT_POSITION_FOLLOWING,
        ),
      ),
    ).toBe(true);
    await stats.scrollIntoViewIfNeeded();
    expect(
      await stats.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
    if (process.env.CAPTURE_SHARE_STATS) {
      await page.locator(".article-read-footer").scrollIntoViewIfNeeded();
      await page.screenshot({
        path: `/tmp/footer-share-stats/${language}-${testInfo.project.name}.png`,
      });
      await page.emulateMedia({ colorScheme: "dark" });
      await page.screenshot({
        path: `/tmp/footer-share-stats/${language}-${testInfo.project.name}-dark.png`,
      });
    }
    await page.emulateMedia({ media: "print" });
    await expect(stats).toBeHidden();

    await page.goto(`/s/${token}`);
    await expect(page.locator("#article > h1")).toBeVisible();
    await expect(page.locator(".article-share-stats")).toHaveCount(0);
  });
}

test("footer statistics distinguish unavailable counts from zero and retry", async ({
  page,
}) => {
  let fail = true;
  await page.route(`**/api/jobs/${articleId}/share-stats`, (route) =>
    route.fulfill(
      fail ? { status: 503, json: {} } : { json: { loads: 0, reads: 0 } },
    ),
  );
  await openArticle(page);
  await expect(page.locator("#share-stats-retry")).toBeVisible();
  await expect(page.locator("#share-stats-values")).toBeHidden();

  fail = false;
  await page.locator("#share-stats-retry").click();

  await expect(page.locator("#share-stats-loads")).toHaveText("0");
  await expect(page.locator("#share-stats-reads")).toHaveText("0");
  await expect(page.locator("#share-stats-retry")).toBeHidden();
});

test("late statistics from a previous article do not replace the current counts", async ({
  page,
}) => {
  let release;
  let requested;
  const started = new Promise((resolve) => {
    requested = resolve;
  });
  const delayed = new Promise((resolve) => {
    release = resolve;
  });
  await page.route(`**/api/jobs/${articleId}/share-stats`, async (route) => {
    requested();
    await delayed;
    await route.fulfill({ json: { loads: 99, reads: 50 } });
  });
  const otherId = "00000000-0000-4000-8000-000000000932";
  await page.route(`**/api/jobs/${otherId}`, (route) =>
    route.fulfill({ json: { ...articleFixture(), id: otherId } }),
  );
  await page.route(`**/api/jobs/${otherId}/share-stats`, (route) =>
    route.fulfill({ json: { loads: 3, reads: 1 } }),
  );
  await openArticle(page);
  await started;

  await page.goto(`/#job=${otherId}`);
  await expect(page.locator("#share-stats-loads")).toHaveText("3");
  const oldResponse = page.waitForResponse(
    `**/api/jobs/${articleId}/share-stats`,
  );
  release();
  await oldResponse;

  await expect(page.locator("#share-stats-loads")).toHaveText("3");
  await expect(page.locator("#share-stats-reads")).toHaveText("1");
});

test("shared opens wait for two visible seconds after rendering", async ({
  page,
}) => {
  // Simulate a normal reader so this test exercises the timing rule.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
  });
  const start = new Date("2026-09-19T12:00:00Z");
  await page.clock.install({ time: start });
  await page.clock.pauseAt(start);
  const events = [];
  await page.route(`**/api/shared/${token}/events`, async (route) => {
    events.push(route.request().postDataJSON().event);
    await route.fulfill({ status: 204 });
  });
  await page.goto(`/s/${token}`);
  await expect(page.locator("#article > h1")).toBeVisible();

  await page.clock.runFor(1999);
  expect(events).toEqual([]);
  await page.clock.runFor(1);

  await expect.poll(() => events).toEqual(["load"]);
  await page.clock.runFor(2000);
  expect(events).toEqual(["load"]);
});

test("declared WebDriver automation can read but sends no monitoring events", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => true });
  });
  const start = new Date("2026-09-19T12:00:00Z");
  await page.clock.install({ time: start });
  await page.clock.pauseAt(start);
  const events = [];
  await page.route(`**/api/shared/${token}/events`, async (route) => {
    events.push(route.request().postDataJSON());
    await route.fulfill({ status: 204 });
  });
  await page.goto(`/s/${token}`);
  await expect(page.locator("#article > h1")).toBeVisible();

  await page
    .locator("#article")
    .evaluate((element) => element.scrollIntoView({ block: "end" }));
  await page.clock.runFor(60_000);

  expect(events).toEqual([]);
  await expect(page.locator("#article > h1")).toBeVisible();
});
