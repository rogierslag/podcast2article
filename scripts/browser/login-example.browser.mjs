import { test, expect } from "@playwright/test";
import { password } from "./fixture.mjs";
import { translate } from "../../public/i18n.js";

const exampleUrl =
  "https://reads.rogierslag.nl/s/_eUKVjs2CsydDZ7nEseiXUNRYc64L1Pp2EPQ8LLIGng";

for (const language of ["en", "nl"]) {
  test(`${language}: example opens separately and preserves the login form`, async ({
    page,
    context,
    isMobile,
  }) => {
    await context.addCookies([
      {
        name: "p2a_ui_language",
        value: language,
        url: "http://127.0.0.1:4317",
      },
    ]);
    // Keep this navigation check independent of production and its visit counters.
    await context.route(exampleUrl, (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<title>Example article</title><h1>Example article</h1>",
      }),
    );
    const sourceUrl = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
    await page.goto(`/login?sourceUrl=${encodeURIComponent(sourceUrl)}`);
    await page.locator("#username").fill("regression");
    const link = page.getByRole("link", {
      name: translate(language, "login.exampleOpen"),
    });

    await expect(link).toHaveAttribute("href", exampleUrl);
    await expect(link).toHaveAttribute("rel", "noopener noreferrer");
    await expect(page.locator(".example-link")).toContainText(
      translate(language, "login.exampleHint"),
    );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    const popupPromise = context.waitForEvent("page");
    if (isMobile) {
      await link.tap();
    } else {
      await page.locator("#username").focus();
      await page.keyboard.press("Shift+Tab");
      await expect(link).toBeFocused();
      await page.keyboard.press("Enter");
    }
    const popup = await popupPromise;
    await expect(popup).toHaveURL(exampleUrl);
    await expect(page).toHaveURL(/\/login\?sourceUrl=/);
    await expect(page.locator("#username")).toHaveValue("regression");
    await expect(page.locator('input[name="sourceUrl"]')).toHaveValue(
      sourceUrl,
    );
    await popup.close();

    await page.locator("#password").fill(password);
    await page
      .getByRole("button", {
        name: translate(language, "login.submit"),
        exact: true,
      })
      .click();
    await expect(page).not.toHaveURL(/\/login/);
    expect(new URL(page.url()).searchParams.get("sourceUrl")).toBe(sourceUrl);
  });
}
