import { test, expect } from "@playwright/test";
import { articleId, password, token } from "./fixture.mjs";

test("real library reports anonymous measurements from login, owner and shared pages", async ({
  page,
}) => {
  await page.goto("/login");
  const supportsCLS = await page.evaluate(() =>
    PerformanceObserver.supportedEntryTypes.includes("layout-shift"),
  );
  test.skip(!supportsCLS, "This browser does not expose CLS measurements.");
  // Production excludes WebDriver; enable only this test's disposable browser page.
  await page.addInitScript(() =>
    Object.defineProperty(navigator, "webdriver", { get: () => false }),
  );
  const submissions = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/api/web-vitals")) {
      submissions.push({
        headers: request.headers(),
        report: request.postDataJSON(),
      });
    }
  });
  for (const [url, pageType] of [
    ["/login", "login"],
    [`/s/${token}`, "shared-article"],
    [`/#job=${articleId}`, "article"],
  ]) {
    if (pageType === "article") {
      await page.request.post("/login", {
        form: { username: "regression", password },
      });
    }
    await page.goto(url);
    await expect(page.locator('meta[name="app-release"]')).toHaveAttribute(
      "content",
      "1234567890123456789012345678901234567890",
    );
    if (pageType !== "login") {
      await expect(page.locator("#article > h1")).toBeVisible();
    }
    // CLS initialization follows first contentful paint, which can lag navigation on CI.
    await expect
      .poll(() =>
        page.evaluate(
          () => performance.getEntriesByName("first-contentful-paint").length,
        ),
      )
      .toBeGreaterThan(0);
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    const stored = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/web-vitals") &&
        response.request().postDataJSON().name === "CLS",
    );

    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => "hidden",
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });

    expect((await stored).status()).toBe(204);
    expect(
      submissions.some(
        ({ report }) => report.name === "CLS" && report.page === pageType,
      ),
    ).toBe(true);
  }
  for (const { headers, report } of submissions) {
    expect(headers.cookie).toBeUndefined();
    expect(headers.referer || undefined).toBeUndefined();
    expect(Object.keys(report).sort()).toEqual([
      "id",
      "layout",
      "name",
      "navigationType",
      "page",
      "release",
      "sequence",
      "value",
    ]);
    expect(JSON.stringify(report)).not.toContain(token);
    expect(JSON.stringify(report)).not.toContain(articleId);
  }
});

test("ordinary automated browser checks do not report field measurements", async ({
  page,
}) => {
  const submissions = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/api/web-vitals")) {
      submissions.push(request.url());
    }
  });

  await page.goto(`/s/${token}`);
  await expect(page.locator("#article > h1")).toBeVisible();
  await page.goto("/login");

  expect(submissions).toEqual([]);
});
