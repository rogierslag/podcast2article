import { test, expect } from "@playwright/test";
import { password } from "./fixture.mjs";

test.use({ video: "on" });

test.beforeEach(async ({ page }) => {
  await page.route(/^https?:\/\/(?!127\.0\.0\.1:4317)/, (route) =>
    route.abort(),
  );
  await page.request.post("/login", {
    form: { username: "regression", password },
  });
});

for (const url of ["/articles", "/series"]) {
  test(`${url}: delayed logout appears in the footer without moving the page`, async ({
    page,
  }, testInfo) => {
    const authRequested = Promise.withResolvers();
    const authResponse = Promise.withResolvers();
    await page.route("**/api/auth", async (route) => {
      authRequested.resolve();
      await authResponse.promise;
      await route.continue();
    });
    await page.goto(url);
    await authRequested.promise;
    await expect(
      page.locator(url === "/articles" ? ".article-card" : "#series-list"),
    ).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    const logout = page
      .locator(".owner-footer")
      .getByRole("button", { name: "Uitloggen" });
    await expect(logout).toBeHidden();
    await expect(page.locator(".main-nav #logout-form")).toHaveCount(0);
    await page.locator(".owner-footer").scrollIntoViewIfNeeded();
    const layout = () =>
      page.evaluate(() => {
        const bounds = [
          ".nav",
          "main",
          ".owner-footer",
          ".language-switcher",
        ].map((selector) => {
          const { x, y, width, height } = document
            .querySelector(selector)
            .getBoundingClientRect();
          return { x, y, width, height };
        });
        return { bounds, height: document.documentElement.scrollHeight };
      });
    const before = await layout();

    authResponse.resolve();
    await expect(logout).toBeVisible();

    expect(await layout()).toEqual(before);
    await logout.focus();
    await expect(logout).toBeFocused();
    await page.screenshot({
      path: testInfo.outputPath("footer.png"),
      fullPage: true,
    });
    await logout.click();
    await expect(page).toHaveURL(/\/login$/);
    const response = await page.request.get("/api/articles");
    expect(response.status()).toBe(401);
  });

  test(`${url}: logout stays unavailable without authentication`, async ({
    page,
  }) => {
    await page.route("**/api/auth", (route) =>
      route.fulfill({ json: { enabled: false } }),
    );
    await page.goto(url);

    await expect(page.locator("#logout-form")).toBeHidden();
    await expect(page.getByRole("button", { name: "Uitloggen" })).toHaveCount(
      0,
    );
  });
}

for (const url of ["/articles", "/series"]) {
  test(`${url}: footer stacks utilities below side-by-side languages with large tap targets`, async ({
    page,
  }) => {
    await page.goto(url);
    await expect(page.locator("#logout-form")).toBeVisible();
    const footer = page.locator(".owner-footer");
    await footer.scrollIntoViewIfNeeded();
    const controls = await footer.locator("button, a").evaluateAll((elements) =>
      elements.map((element) => {
        const { x, y, width, height } = element.getBoundingClientRect();
        return { x, y, width, height };
      }),
    );

    expect(controls).toHaveLength(6);
    for (const control of controls) {
      expect(control.width).toBeGreaterThanOrEqual(44);
      expect(control.height).toBeGreaterThanOrEqual(44);
    }
    expect(controls[0].y).toBe(controls[1].y);
    expect(controls[0].x + controls[0].width).toBeLessThanOrEqual(
      controls[1].x,
    );
    expect(controls[4].y).toBe(controls[5].y);
    expect(controls[4].y).toBeGreaterThanOrEqual(
      controls[3].y + controls[3].height,
    );
    expect(controls[4].x + controls[4].width).toBeLessThanOrEqual(
      controls[5].x,
    );
    await expect(footer.locator(".footer-credits a").first()).toHaveCSS(
      "font-size",
      "10px",
    );
    const footerBounds = await footer.boundingBox();
    for (let index = 2; index < 4; index++) {
      const control = controls[index];
      const previous = controls[index - 1];
      expect(control.y).toBeGreaterThanOrEqual(previous.y + previous.height);
      expect(
        Math.abs(
          control.x +
            control.width / 2 -
            (footerBounds.x + footerBounds.width / 2),
        ),
      ).toBeLessThan(1);
    }
  });
}
