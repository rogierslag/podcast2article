import { test, expect } from "@playwright/test";
import { articleFixture, articleId, password } from "./fixture.mjs";

const feedUrl = "https://example.com/feed.xml";
const subscriptionId = "00000000-0000-4000-8000-000000000781";
test.use({ video: "on" });
test.beforeEach(async ({ page }) => {
  await page.route(/^https?:\/\/(?!127\.0\.0\.1:4317)/, (route) =>
    route.abort(),
  );
  await page.request.post("/login", {
    form: { username: "regression", password },
  });
});
async function openArticle(page, sourceType = "spotify") {
  const job = articleFixture();
  job.episode.sourceType = sourceType;
  job.episode.sourceName = "De werkweek";
  job.episode.feedUrl = feedUrl;
  job.readAt = "2026-09-19T08:00:00Z";
  await page.route(`**/api/jobs/${articleId}`, (route) =>
    route.fulfill({ json: job }),
  );
  await page.goto("/");
  await page.goto(`/#job=${articleId}`);
  await expect(page.locator("#article > h1")).toHaveText(job.article.title);
}

test("article series: follow, return to article and manage paused subscription", async ({
  page,
}, testInfo) => {
  let followed = false;
  let paused = false;
  let submitted;
  await page.route("**/api/subscriptions**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname.includes("/article/")) {
      return route.fulfill({
        json: {
          feedUrl,
          subscription: followed ? { id: subscriptionId, paused } : null,
        },
      });
    }
    if (pathname.endsWith("/preview")) {
      expect(request.postDataJSON()).toEqual({ url: feedUrl });
      return route.fulfill({
        json: {
          id: subscriptionId,
          title: "De werkweek",
          url: feedUrl,
          count: 30,
          episodes: [
            { title: "Waarom aandacht en samenwerking ruimte nodig hebben" },
          ],
        },
      });
    }
    if (request.method() === "POST") {
      submitted = request.postDataJSON();
      followed = true;
      return route.fulfill({ status: 202, json: { id: subscriptionId } });
    }
    return route.fulfill({
      json: followed
        ? [
            {
              id: subscriptionId,
              feedUrl,
              title: "De werkweek",
              paused,
              complete: 1,
              processing: 0,
              outstanding: 0,
              archiveCount: 0,
              pendingCount: 0,
              failed: [],
            },
          ]
        : [],
    });
  });
  await openArticle(page);
  const panels = page.locator("[data-article-series]");
  await expect(panels.first()).toContainText("Volg deze podcast");
  await expect(panels.last()).toContainText("Volg deze podcast");
  await panels.first().scrollIntoViewIfNeeded();
  await page.screenshot({
    path: testInfo.outputPath("article-follow-top.png"),
  });
  await panels.last().scrollIntoViewIfNeeded();
  await page.screenshot({
    path: testInfo.outputPath("article-follow-footer.png"),
  });
  await panels.last().getByRole("link", { name: "Volg deze podcast" }).click();
  await expect(page.locator("#series-preview-title")).toHaveText("De werkweek");
  await expect(page.locator("#series-preview-title")).toBeFocused();
  await expect(page.locator("#series-backfill")).toHaveValue("none");
  expect(followed).toBe(false);
  await page.getByRole("button", { name: "Bevestig en volg serie" }).click();
  expect(submitted.backfill).toBe("none");
  await page.goBack();
  await expect(panels.first()).toContainText("Je volgt deze podcast");
  await panels.last().scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("article-following.png") });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.screenshot({
    path: testInfo.outputPath("article-following-dark.png"),
  });
  await page.emulateMedia({ media: "print" });
  await expect(panels.first()).toBeHidden();
  await expect(panels.last()).toBeHidden();
  await page.emulateMedia({ media: "screen", colorScheme: "light" });
  paused = true;
  await page.reload();
  await expect(panels.first()).toContainText(
    "Je volgt deze podcast · gepauzeerd",
  );
  await panels.last().scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("article-paused.png") });
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    )
    .toBe(true);
  await panels.last().getByRole("link", { name: "Beheer serie" }).click();
  await expect(page.locator(`#subscription-${subscriptionId}`)).toBeFocused();
});

test("article series: discovery errors can be retried and other sources hide the action", async ({
  page,
}) => {
  let unavailable = true;
  await page.route("**/api/subscriptions/article/*", (route) =>
    route.fulfill(
      unavailable
        ? { status: 400, json: { error: "Unavailable" } }
        : { json: { feedUrl, subscription: null } },
    ),
  );
  await openArticle(page);
  const panel = page.locator("[data-article-series]").first();
  await expect(panel).toContainText("De volgstatus is niet beschikbaar");
  unavailable = false;
  await panel.getByRole("button", { name: "Probeer opnieuw" }).focus();
  await page.keyboard.press("Enter");
  await expect(
    panel.getByRole("link", { name: "Volg deze podcast" }),
  ).toBeVisible();
  await expect(
    panel.getByRole("link", { name: "Volg deze podcast" }),
  ).toBeFocused();
  await openArticle(page, "google-drive");
  await expect(panel).toBeHidden();
});
