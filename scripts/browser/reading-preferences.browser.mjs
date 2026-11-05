import { test, expect } from "@playwright/test";
import { articleId, password, token } from "./fixture.mjs";

test.beforeEach(async ({ page }) => {
  await page.request.post("/login", {
    form: { username: "regression", password },
  });
});

for (const reader of ["owner", "shared"]) {
  test(`${reader}: reading preferences scroll out of view with the header`, async ({
    page,
  }) => {
    await page.goto(reader === "owner" ? `/#job=${articleId}` : `/s/${token}`);
    await expect(page.locator("#article > h1")).toBeVisible();
    const preferences = page.locator(".reading-preferences summary");
    await expect(preferences).toBeInViewport();
    const initialTop = await preferences.evaluate(
      (element) => element.getBoundingClientRect().top,
    );
    const headerTop = await page
      .locator("header.nav")
      .evaluate((element) => element.getBoundingClientRect().top);

    await page
      .locator("#article section > h2")
      .first()
      .evaluate((heading) => {
        heading.scrollIntoView({ behavior: "instant", block: "start" });
      });

    await expect
      .poll(() =>
        preferences.evaluate(
          (element) => element.getBoundingClientRect().bottom,
        ),
      )
      .toBeLessThan(0);
    const offset = await preferences.evaluate(
      (element) =>
        element.getBoundingClientRect().top -
        element.closest("header.nav").getBoundingClientRect().top,
    );
    expect(offset).toBeCloseTo(initialTop - headerTop, 0);
  });
}

test("reading preferences persist across owner and anonymous pages without changing article content", async ({
  page,
  context,
}) => {
  await page.goto(`/#job=${articleId}`);
  await expect(page.locator("#article > h1")).toBeVisible();
  const text = await page.locator("#article").textContent();
  const originalSize = await page
    .locator("#article section > p")
    .first()
    .evaluate((element) => parseFloat(getComputedStyle(element).fontSize));
  await page.locator(".reading-preferences summary").click();
  await page.locator('[name="reading-theme"][value="evening"]').check();
  await page.locator('[name="reading-size"][value="large"]').check();
  await page.locator('[name="reading-font"][value="sans"]').check();
  await expect(page.locator("html")).toHaveAttribute(
    "data-reading-theme",
    "evening",
  );
  expect(
    await page
      .locator("#article section > p")
      .first()
      .evaluate((element) => parseFloat(getComputedStyle(element).fontSize)),
  ).toBeGreaterThan(originalSize);
  await page.keyboard.press("Escape");
  await expect(page.locator(".reading-preferences summary")).toBeFocused();
  expect(await page.locator("#article").textContent()).toBe(text);
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute(
    "data-reading-size",
    "large",
  );
  await context.clearCookies();
  await page.goto(`/s/${token}`);
  await expect(page.locator("#article > h1")).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute(
    "data-reading-font",
    "sans",
  );
  await expect(page.locator("html")).toHaveCSS("color-scheme", "dark");
  await page.locator(".reading-preferences summary").click();
  await page.locator('[name="reading-theme"][value="day"]').check();
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveCSS("color-scheme", "light");
  await page.locator('[name="reading-theme"][value="system"]').check();
  await expect(page.locator("html")).toHaveCSS("color-scheme", "dark");
});

test("invalid saved settings and unavailable storage keep the reader usable", async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem(
      "p2a-reading",
      '{"theme":"bad","size":"giant","font":"unknown"}',
    ),
  );
  await page.goto(`/#job=${articleId}`);
  await expect(page.locator("html")).toHaveAttribute(
    "data-reading-theme",
    "system",
  );
  await expect(page.locator("html")).toHaveAttribute(
    "data-reading-size",
    "standard",
  );
  await expect(page.locator("html")).toHaveAttribute(
    "data-reading-font",
    "serif",
  );
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", {
      get() {
        throw new Error("Storage unavailable");
      },
    });
  });
  await page.reload();
  await page.locator(".reading-preferences summary").click();
  await page.locator('[name="reading-size"][value="large"]').check();
  await expect(page.locator("html")).toHaveAttribute(
    "data-reading-size",
    "large",
  );
  await expect(page.locator("#article > h1")).toBeVisible();
});
