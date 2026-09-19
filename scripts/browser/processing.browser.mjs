import { test, expect } from "@playwright/test";
import { articleFixture, articleId, password } from "./fixture.mjs";

test.beforeEach(async ({ page }) => {
  await page.route(/^https?:\/\/(?!127\.0\.0\.1:4317)/, (route) =>
    route.abort(),
  );
  await page.request.post("/login", {
    form: { username: "regression", password },
  });
});

function processingFixture(overrides = {}) {
  return {
    ...articleFixture(),
    article: undefined,
    stage: "writing",
    progress: 82,
    message: "Het artikel wordt geschreven",
    ...overrides,
  };
}

async function openJob(page, job) {
  await page.route(`**/api/jobs/${articleId}`, (route) =>
    route.fulfill({ json: job }),
  );
  await page.goto(`/#job=${articleId}`);
}

test("processing: stage and progress stay readable with a way back to the library", async ({
  page,
}) => {
  const job = processingFixture();
  await openJob(page, job);

  await expect(page.locator("#progress-title")).toHaveText(job.episode.title);
  await expect(page.locator("#job-progress")).toHaveAttribute(
    "aria-valuenow",
    "82",
  );
  await expect(page.locator("#progress-message")).toHaveText(job.message);
  await expect(page.locator("#progress-hint")).toContainText(
    "Je kunt dit scherm verlaten",
  );
  await expect(page.locator("#job-article-retry")).toBeHidden();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.getByRole("link", { name: "Naar artikelen", exact: true }).click();
  await expect(page).toHaveURL(/\/articles$/);
});

test("processing: failed writing preserves context and only retries the article on request", async ({
  page,
}) => {
  let job = processingFixture({
    stage: "failed",
    error: "Het artikel kon niet worden geschreven.",
  });
  let retries = 0;
  await page.route(`**/api/jobs/${articleId}`, (route) =>
    route.fulfill({ json: job }),
  );
  await page.route(`**/api/jobs/${articleId}/retry-article`, async (route) => {
    expect(route.request().method()).toBe("POST");
    retries += 1;
    job = processingFixture();
    await route.fulfill({ status: 202, json: job });
  });
  await page.goto(`/#job=${articleId}`);

  await expect(page.locator("#progress-title")).toHaveText(job.episode.title);
  await expect(page.locator("#progress-error")).toHaveText(job.error);
  await expect(page.locator("#progress-error")).toBeInViewport();
  await expect(page.locator("#landing")).toBeHidden();
  await expect(page.locator("#job-progress")).toBeHidden();
  await expect(page.locator("#progress-hint")).toContainText(
    "extra API-kosten",
  );
  expect(retries).toBe(0);

  await page
    .getByRole("button", { name: "Maak artikel opnieuw", exact: true })
    .click();

  await expect(page.locator("#job-progress")).toBeVisible();
  await expect(page.locator("#progress-error")).toBeEmpty();
  expect(retries).toBe(1);
});

test("processing: early failure restores source, language and length without starting a job", async ({
  page,
}) => {
  const job = processingFixture({
    stage: "failed",
    transcript: undefined,
    episode: undefined,
    sourceUrl: "https://www.youtube.com/watch?v=abcdefghijk",
    language: "en",
    articleLength: "compact",
    error: "De opname kon niet worden opgehaald.",
  });
  const mutations = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/jobs") && request.method() !== "GET") {
      mutations.push(request.url());
    }
  });
  await openJob(page, job);

  await expect(page.locator("#job-article-retry")).toBeHidden();
  await expect(page.locator("#progress-title")).toHaveText(
    "Verwerking gestopt",
  );
  await expect(page.locator("#progress-error")).toHaveText(job.error);
  await page
    .getByRole("button", { name: "Bekijk bron en instellingen", exact: true })
    .click();

  await expect(page.locator("#source-url")).toBeFocused();
  await expect(page.locator("#source-url")).toHaveValue(job.sourceUrl);
  await expect(page.locator('[name="language"]')).toHaveValue("en");
  await expect(page.locator('[name="articleLength"]')).toHaveValue("compact");
  await expect(page.locator("#progress-view")).toBeHidden();
  expect(mutations).toEqual([]);
});

test("processing: unavailable status can be checked again without paid processing", async ({
  page,
}) => {
  let unavailable = true;
  const mutations = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/jobs") && request.method() !== "GET") {
      mutations.push(request.url());
    }
  });
  await page.route(`**/api/jobs/${articleId}`, (route) =>
    unavailable
      ? route.fulfill({ status: 503, json: { error: "Unavailable" } })
      : route.fulfill({ json: articleFixture() }),
  );
  await page.goto(`/#job=${articleId}`);

  await expect(page.locator("#progress-kicker")).toHaveText(
    "Status niet beschikbaar",
  );
  await expect(page.locator("#job-article-retry")).toBeHidden();
  await expect(page.locator("#progress-hint")).toContainText(
    "dit start geen nieuwe opdracht",
  );
  unavailable = false;
  await page
    .getByRole("button", { name: "Controleer status opnieuw", exact: true })
    .click();

  await expect(page.locator("#article > h1")).toHaveText(
    articleFixture().article.title,
  );
  expect(mutations).toEqual([]);
});

test("processing: rejected regeneration requires a status check before another paid retry", async ({
  page,
}) => {
  await page.route(`**/api/jobs/${articleId}/retry-article`, (route) =>
    route.fulfill({
      status: 409,
      json: { error: "Deze opdracht wordt al verwerkt." },
    }),
  );
  await openJob(
    page,
    processingFixture({ stage: "failed", error: "Artikel schrijven mislukt." }),
  );
  await page.locator("#job-article-retry").click();

  await expect(page.locator("#progress-error")).toHaveText(
    "Deze opdracht wordt al verwerkt.",
  );
  await expect(page.locator("#job-article-retry")).toBeHidden();
  await expect(page.locator("#job-status-retry")).toBeVisible();
});

test("processing: a lost retry response recovers the accepted job without a second paid request", async ({
  page,
}) => {
  let job = processingFixture({
    stage: "failed",
    error: "Artikel schrijven mislukt.",
  });
  let retries = 0;
  await page.route(`**/api/jobs/${articleId}`, (route) =>
    route.fulfill({ json: job }),
  );
  await page.route(`**/api/jobs/${articleId}/retry-article`, async (route) => {
    retries += 1;
    job = articleFixture();
    await route.abort("failed");
  });
  await page.goto(`/#job=${articleId}`);
  await page.locator("#job-article-retry").click();

  await expect(page.locator("#job-article-retry")).toBeHidden();
  await page.locator("#job-status-retry").click();

  await expect(page.locator("#article > h1")).toHaveText(job.article.title);
  expect(retries).toBe(1);
});

test("processing: navigating to another job removes the previous recovery actions immediately", async ({
  page,
}) => {
  const nextId = "00000000-0000-4000-8000-000000000932";
  let releaseNext;
  const nextReady = new Promise((resolve) => {
    releaseNext = resolve;
  });
  const mutations = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/jobs") && request.method() !== "GET") {
      mutations.push(request.url());
    }
  });
  await page.route(`**/api/jobs/${nextId}`, async (route) => {
    await nextReady;
    await route.fulfill({ json: { ...articleFixture(), id: nextId } });
  });
  await openJob(
    page,
    processingFixture({ stage: "failed", error: "Artikel schrijven mislukt." }),
  );
  await expect(page.locator("#job-article-retry")).toBeVisible();

  await page.evaluate((id) => {
    location.hash = `job=${id}`;
  }, nextId);
  await expect(page.locator("#job-article-retry")).toBeHidden();
  await expect(page.locator("#job-status-retry")).toBeHidden();
  releaseNext();

  await expect(page.locator("#article > h1")).toHaveText(
    articleFixture().article.title,
  );
  await expect(page).toHaveURL(new RegExp(nextId));
  expect(mutations).toEqual([]);
});

test("processing: a missing job does not imply processing is still running", async ({
  page,
}) => {
  await page.route(`**/api/jobs/${articleId}`, (route) =>
    route.fulfill({ status: 404, json: {} }),
  );
  await page.goto(`/#job=${articleId}`);

  await expect(page.locator("#progress-error")).toHaveText(
    "Opdracht niet gevonden.",
  );
  await expect(page.locator("#progress-hint")).toBeEmpty();
  await expect(page.locator("#job-status-retry")).toBeHidden();
  await expect(page.locator("#job-article-retry")).toBeHidden();
  await expect(
    page.getByRole("link", { name: "Naar artikelen", exact: true }),
  ).toBeVisible();
});

test("library: an empty processing shelf does not push unread articles down", async ({
  page,
}) => {
  await page.goto("/articles");

  await expect(page.locator(".article-card").first()).toBeVisible();
  await expect(page.locator(".processing-shelf")).toHaveCount(0);
});

test("processing: pending retries only disable their own job's control", async ({
  page,
}) => {
  const nextId = "00000000-0000-4000-8000-000000000932";
  const failed = processingFixture({
    stage: "failed",
    error: "Artikel schrijven mislukt.",
  });
  let releaseFirst;
  let releaseSecond;
  const firstReady = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const secondReady = new Promise((resolve) => {
    releaseSecond = resolve;
  });
  await page.route(`**/api/jobs/${articleId}/retry-article`, async (route) => {
    await firstReady;
    await route.fulfill({ status: 202, json: processingFixture() });
  });
  await page.route(`**/api/jobs/${nextId}`, (route) =>
    route.fulfill({ json: { ...failed, id: nextId } }),
  );
  await page.route(`**/api/jobs/${nextId}/retry-article`, async (route) => {
    await secondReady;
    await route.fulfill({
      status: 409,
      json: { error: "Deze opdracht wordt al verwerkt." },
    });
  });
  await openJob(page, failed);
  const firstRequest = page.waitForRequest(
    `**/api/jobs/${articleId}/retry-article`,
  );
  await page.locator("#job-article-retry").click();
  await firstRequest;

  await page.evaluate((id) => {
    location.hash = `job=${id}`;
  }, nextId);
  await expect(page.locator("#job-article-retry")).toBeEnabled();
  const secondRequest = page.waitForRequest(
    `**/api/jobs/${nextId}/retry-article`,
  );
  await page.locator("#job-article-retry").click();
  await secondRequest;
  const firstResponse = page.waitForResponse(
    `**/api/jobs/${articleId}/retry-article`,
  );
  releaseFirst();
  await firstResponse;
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );

  await expect(page.locator("#job-article-retry")).toBeDisabled();
  releaseSecond();
  await expect(page.locator("#job-status-retry")).toBeVisible();
  await expect(page).toHaveURL(new RegExp(nextId));
});
