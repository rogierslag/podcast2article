import { test, expect } from "@playwright/test";
import { password } from "./fixture.mjs";

const budget = {
  windowDays: 30,
  spentUsd: 1.44,
  historicalSpendUsd: 0.24,
  countedSpendUsd: 1.2,
  reservedUsd: 0.6,
  unknownCostRequests: 1,
  limitUsd: 5,
  remainingUsd: 3.2,
};

test.beforeEach(async ({ page }) => {
  await page.route(/^https?:\/\/(?!127\.0\.0\.1:4317)/, (route) =>
    route.abort(),
  );
  await page.request.post("/login", {
    form: { username: "regression", password },
  });
});

for (const route of ["/", "/articles", "/series"]) {
  test(`${route}: spending distinguishes historical costs and reservations`, async ({
    page,
  }) => {
    await page.route("**/api/account-budget", (request) =>
      request.fulfill({ json: budget }),
    );
    await page.goto(route);
    const panel = page.locator("#account-budget");
    await expect(panel).not.toBeVisible();
    await page.getByRole("button", { name: "Verbruik", exact: true }).click();
    await expect(panel).toBeVisible();
    await expect(panel).toContainText("1,44");
    await expect(panel).toContainText("3,20 beschikbaar");

    await expect(panel.locator("dl")).toBeVisible();
    await expect(panel).toContainText("Historische kosten · vrijgesteld");
    await expect(panel).toContainText("0,24");
    await expect(panel).toContainText("0,60");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.keyboard.press("Escape");
    await expect(panel).not.toBeVisible();
    await expect(page.locator("#account-budget-open")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(panel).toBeVisible();
    await page.getByRole("button", { name: "Sluiten", exact: true }).click();
    await expect(panel).not.toBeVisible();
    await expect(page.locator("#account-budget-open")).toBeFocused();
  });
}

test("unlimited accounts still show costs and failed refreshes do not claim zero spending", async ({
  page,
}) => {
  let unavailable = false;
  await page.route("**/api/account-budget", (route) =>
    unavailable
      ? route.fulfill({ status: 503, body: "unavailable" })
      : route.fulfill({
          json: { ...budget, limitUsd: null, remainingUsd: null },
        }),
  );
  await page.goto("/articles");
  const panel = page.locator("#account-budget");
  await page.locator("#account-budget-open").click();
  await expect(panel).toContainText("Geen bestedingslimiet");
  await expect(panel).toContainText("1,44");

  unavailable = true;
  await page.locator("#account-budget-close").click();
  await page.locator("#account-budget-open").click();

  await expect(panel).toContainText("Verbruik tijdelijk niet beschikbaar");
  await expect(panel).not.toContainText("1,44");
  await expect(panel.locator("dl")).toHaveCount(0);
});
