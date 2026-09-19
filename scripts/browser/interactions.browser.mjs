import { test, expect } from "@playwright/test";
import { password, articleId, token } from "./fixture.mjs";

test.use({ video: "on" });

async function colors(control) {
  return control.evaluate((element) => {
    const style = getComputedStyle(element);
    return [style.backgroundColor, style.color, style.borderColor];
  });
}

async function checkFeedback(page, control, isMobile) {
  await control.scrollIntoViewIfNeeded();
  await page.mouse.move(0, 0);
  const resting = await colors(control);
  if (!isMobile) {
    await control.hover();
    await expect.poll(() => colors(control)).not.toEqual(resting);
    await page.mouse.move(0, 0);
  }
  await control.focus();
  await page.keyboard.down(" ");
  await expect.poll(() => colors(control)).not.toEqual(resting);
  // Inspect the pressed state without submitting forms or changing stored data.
  await control.evaluate((element) => {
    element.addEventListener(
      "click",
      (event) => {
        event.preventDefault();
        event.stopImmediatePropagation();
      },
      { once: true, capture: true },
    );
  });
  await page.keyboard.up(" ");
  await expect.poll(() => colors(control)).toEqual(resting);
  await control.focus();
  await expect(control).toHaveCSS("outline-style", "solid");
  await expect(control).toHaveCSS("outline-width", "3px");
  await expect(control).toHaveCSS("transition-duration", "0s");
}

for (const colorScheme of ["light", "dark"]) {
  test(`button feedback: series, reader and login in ${colorScheme}`, async ({
    page,
    isMobile,
  }, testInfo) => {
    await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
    await page.route(/^https?:\/\/(?!127\.0\.0\.1:4317)/, (route) =>
      route.abort(),
    );
    await page.goto("/login");
    await checkFeedback(page, page.locator('button[type="submit"]'), isMobile);
    await page.request.post("/login", {
      form: { username: "regression", password },
    });
    await page.route("**/api/subscriptions**", (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname.endsWith("/discover")) {
        return route.fulfill({
          json: [
            {
              title: "De wetenschap van alledag",
              url: "https://example.com/feed",
            },
            {
              title: "Een frisse blik op wetenschap",
              url: "https://example.com/feed2",
            },
          ],
        });
      }
      if (pathname.endsWith("/preview")) {
        return route.fulfill({
          json: {
            id: articleId,
            title: "De wetenschap van alledag",
            url: "https://example.com/feed",
            count: 42,
            episodes: [
              { title: "Waarom slapen we? Een gesprek over ons geheugen" },
            ],
          },
        });
      }
      return route.fulfill({
        json: [
          {
            id: articleId,
            title: "De werkweek",
            paused: false,
            complete: 3,
            processing: 0,
            outstanding: 0,
            archiveCount: 12,
            pendingCount: 0,
            failed: [],
          },
        ],
      });
    });
    await page.goto("/series");
    await checkFeedback(
      page,
      page.getByRole("button", { name: "Zoek serie" }),
      isMobile,
    );
    await checkFeedback(
      page,
      page.locator(".series-control").first(),
      isMobile,
    );
    await page.locator("#series-url").fill("https://example.com/feed");
    await page.getByRole("button", { name: "Zoek serie" }).click();
    await checkFeedback(
      page,
      page.locator(".series-candidate").first(),
      isMobile,
    );
    await page.locator(".series-candidate").first().click();
    const primary = page.locator(".series-primary");
    await checkFeedback(page, primary, isMobile);
    await primary.evaluate((element) => {
      element.disabled = true;
    });
    const disabled = await colors(primary);
    await primary.hover({ force: true });
    expect(await colors(primary)).toEqual(disabled);
    await primary.evaluate((element) => {
      element.disabled = false;
    });
    await page.mouse.move(0, 0);
    await primary.focus();
    expect(
      await page
        .locator("html")
        .evaluate((element) => element.scrollWidth <= innerWidth),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`series-${colorScheme}.png`),
      fullPage: true,
    });
    await page.goto(`/#job=${articleId}`);
    await expect(page.locator("#article > h1")).toBeVisible();
    await checkFeedback(
      page,
      page.locator(".article-actions button").first(),
      isMobile,
    );
    await checkFeedback(
      page,
      page.locator(".article-read-footer button").first(),
      isMobile,
    );
    await checkFeedback(
      page,
      page.locator(".transcript-actions button").first(),
      isMobile,
    );
    await page.goto(`/s/${token}`);
    await expect(page.locator("#article > h1")).toBeVisible();
    await checkFeedback(page, page.locator(".source-link").first(), isMobile);
    await page.locator(".source-link").first().click();
    await checkFeedback(
      page,
      page.locator(".source-preview-header button"),
      isMobile,
    );
  });
}
