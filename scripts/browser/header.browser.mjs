import { test, expect } from "@playwright/test";
import { articleId, password, token } from "./fixture.mjs";

for (const width of [320, 390]) {
  test(`owner and public wordmarks stay visible at ${width}px with tripled text`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.route(/^https?:\/\/(?!127\.0\.0\.1:4317)/, (route) =>
      route.abort(),
    );
    await page.request.post("/login", {
      form: { username: "regression", password },
    });

    for (const url of [`/#job=${articleId}`, `/s/${token}`]) {
      await page.goto(url);
      const wordmark = page.locator(".brand > span:last-child");
      await expect(wordmark).toHaveText("Podcast2Article");
      const fontSize = await wordmark.evaluate((element) =>
        parseFloat(getComputedStyle(element).fontSize),
      );

      // Text-only enlargement reproduces the Safari failure without shrinking the viewport or concealing overflow behind the page's scroll shell.
      await page.addStyleTag({
        content: `.brand { font-size: ${fontSize * 3}px; }`,
      });

      const bounds = await wordmark.evaluate((element) => {
        const range = document.createRange();
        range.selectNodeContents(element);
        const header = element.closest(".nav").getBoundingClientRect();
        return [...range.getClientRects()].map((rect) => ({
          left: rect.left,
          right: rect.right,
          top: rect.top - header.top,
          bottom: rect.bottom - header.bottom,
        }));
      });
      for (const rect of bounds) {
        expect(rect.left).toBeGreaterThanOrEqual(0);
        expect(rect.right).toBeLessThanOrEqual(width);
        expect(rect.top).toBeGreaterThanOrEqual(0);
        expect(rect.bottom).toBeLessThanOrEqual(0);
      }
    }
  });
}
