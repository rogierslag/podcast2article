import { test, expect } from "@playwright/test";
import { password } from "./fixture.mjs";

test("source input stays readable and focusable without restricting page zoom", async ({
  page,
}) => {
  const response = await page.request.post("/login", {
    form: { username: "regression", password },
  });
  expect(response.ok()).toBeTruthy();
  await page.goto("/");
  const input = page.locator("#source-url");

  for (const width of [320, 390, 800, 801, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    // Desktop WebKit does not reproduce the iOS keyboard's automatic zoom.
    // Guard the readable mobile font size that prevents that behavior instead.
    await expect(input).toHaveCSS("font-size", width <= 800 ? "16px" : "15px");
    await input.click();
    await input.fill("https://www.youtube.com/watch?v=aqz-KE-bpKQ");

    await expect(input).toBeFocused();
    await expect(input).toHaveAccessibleName(/\S/);
    await expect(input).toHaveValue(
      "https://www.youtube.com/watch?v=aqz-KE-bpKQ",
    );
    await expect
      .poll(() =>
        page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      )
      .toBe(true);
  }
  const viewport = await page
    .locator('meta[name="viewport"]')
    .getAttribute("content");
  expect(viewport).not.toMatch(/user-scalable\s*=\s*no|maximum-scale\s*=/i);
});
