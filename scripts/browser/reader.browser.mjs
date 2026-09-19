import { test, expect } from "@playwright/test";
import { articleFixture, articleId, password, token } from "./fixture.mjs";

async function login(page) {
  const response = await page.request.post("/login", {
    form: { username: "regression", password },
  });
  expect(response.ok()).toBeTruthy();
}
async function owner(page, job = articleFixture()) {
  await login(page);
  await page.route(`**/api/jobs/${articleId}`, (route) =>
    route.fulfill({ json: job }),
  );
  await page.goto(`/`);
  await page.goto(`/#job=${articleId}`);
  await expect(page.locator("#article > h1")).toHaveText(job.article.title);
}
async function shared(page) {
  await page.goto(`/s/${token}`);
  await expect(page.locator("#article > h1")).toHaveText(
    articleFixture().article.title,
  );
}
async function noOverflow(
  page,
  selectors = "html, body, .page-scroll, #article, #episode-hero",
) {
  // WebKit applies viewport changes asynchronously; assert the settled layout.
  await expect
    .poll(() =>
      page.locator(selectors).evaluateAll((elements) =>
        elements
          .filter((element) => element.scrollWidth > element.clientWidth + 1)
          .map((element) => ({
            element: element.id || element.tagName,
            clientWidth: element.clientWidth,
            scrollWidth: element.scrollWidth,
          })),
      ),
    )
    .toEqual([]);
}

test.beforeEach(async ({ page }) => {
  // Layout tests use installed fallback fonts, with no external requests or API costs.
  await page.route(/^https?:\/\/(?!127\.0\.0\.1:4317)/, (route) =>
    route.abort(),
  );
});

for (const reader of ["owner", "shared"]) {
  test(`${reader}: takeaway timestamps wrap between buttons without splitting times`, async ({
    page,
  }, testInfo) => {
    const job = articleFixture();
    job.transcript = Array.from({ length: 8 }, (_, index) => ({
      ...job.transcript[0],
      id: `t-${String(index + 1).padStart(5, "0")}`,
      start: 3605 + index * 125,
      end: 3610 + index * 125,
    }));
    job.article.takeaways = [
      {
        text: "Geef teams de tijd om ideeën uit te werken en maak bewust ruimte voor aandacht en samenwerking.",
        sources: job.transcript.map((segment) => segment.id),
      },
    ];
    if (reader === "owner") {
      await owner(page, job);
    } else {
      await page.route(`**/api/shared/${token}`, (route) =>
        route.fulfill({
          json: {
            episode: job.episode,
            article: job.article,
            sources: job.transcript.map(({ id, start }) => ({ id, start })),
          },
        }),
      );
      await shared(page);
    }

    const takeaways = page.locator(".takeaways");
    await takeaways.scrollIntoViewIfNeeded();
    await testInfo.attach(`${reader}-takeaways`, {
      body: await takeaways.screenshot(),
      contentType: "image/png",
    });

    for (const width of [390, 320, 1440]) {
      await page.setViewportSize({ width, height: width < 800 ? 844 : 1000 });
      await noOverflow(page, ".takeaways, .takeaways li, .takeaways .sources");
      const buttons = takeaways.getByRole("button");
      await expect(buttons).toHaveCount(8);
      const lines = await buttons.evaluateAll((elements) =>
        elements.map((button) => {
          const range = document.createRange();
          range.selectNodeContents(button);
          return [...range.getClientRects()].filter((rect) => rect.width > 0)
            .length;
        }),
      );
      expect(lines).toEqual(Array(8).fill(1));
      for (const button of await buttons.all()) {
        await expect(button).toHaveAccessibleName(/\d+:\d+/);
      }
    }
  });
}

for (const reader of ["owner", "shared"]) {
  test(`${reader}: long text and artwork-free headers fit narrow and desktop widths (PRs 22, 24, 26, 32)`, async ({
    page,
  }, testInfo) => {
    await (reader === "owner" ? owner(page) : shared(page));
    await testInfo.attach(`${reader}-initial`, {
      body: await page.screenshot(),
      contentType: "image/png",
    });
    for (const width of [320, 390, 600, 800, 801, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      await noOverflow(page, "#article, #episode-hero, .content-layout");
      const widthOfText = await page
        .locator("#episode-hero h1")
        .evaluate((element) => element.getBoundingClientRect().width);
      expect(widthOfText).toBeGreaterThan(width <= 800 ? width * 0.6 : 400);
      // Check actual line boxes: ordinary words must not split into two lines.
      const words = await page.locator("#article > h1").evaluate((heading) => {
        const node = heading.firstChild;
        return [...node.textContent.matchAll(/\S+/g)].map((match) => {
          const range = document.createRange();
          range.setStart(node, match.index);
          range.setEnd(node, match.index + match[0].length);
          return {
            word: match[0],
            lines: new Set(
              [...range.getClientRects()].map((rect) => Math.round(rect.top)),
            ).size,
          };
        });
      });
      expect(words.every((word) => word.lines === 1)).toBeTruthy();
      await expect(page.locator("#article h1")).toHaveCSS("hyphens", "manual");
    }
    await expect(page.locator("#episode-hero img")).toHaveCount(0);
  });

  test(`${reader}: progress stays at the top and completes at the article boundary (PRs 11–16, 23)`, async ({
    page,
  }) => {
    await (reader === "owner" ? owner(page) : shared(page));
    const progress = page.getByRole("progressbar");
    await expect(progress).toHaveAttribute("aria-valuenow", "0");
    await page.evaluate((reader) => {
      const article = document.querySelector("#article");
      const surface =
        reader === "owner"
          ? document.scrollingElement
          : document.querySelector(".page-scroll");
      const viewportTop =
        reader === "owner" ? 0 : surface.getBoundingClientRect().top;
      const end =
        surface.scrollTop +
        article.getBoundingClientRect().bottom -
        viewportTop -
        (reader === "owner" ? innerHeight : surface.clientHeight);
      surface.scrollTo({ top: end + 5, behavior: "instant" });
    }, reader);
    await expect(progress).toHaveAttribute("aria-valuenow", "100");
    const bounds = await progress.boundingBox();
    expect(bounds.y).toBe(0);
    expect(bounds.height).toBe(4);
    await page.emulateMedia({ media: "print" });
    await expect(progress).toBeHidden();
  });
}

test("login fields avoid iOS focus zoom and retain the session on navigation (PRs 1, 29)", async ({
  page,
}) => {
  await page.goto("/login");
  for (const name of ["username", "password"]) {
    const field = page.locator(`#${name}`);
    await field.click();
    await expect(field).toBeFocused();
    expect(
      await field.evaluate((element) =>
        parseFloat(getComputedStyle(element).fontSize),
      ),
    ).toBeGreaterThanOrEqual(16);
  }
  await noOverflow(page);
  await page.locator("#username").click();
  await expect(page.locator("#username")).toBeFocused();
  await page.locator("#username").fill("regression");
  await expect(page.locator("#username")).toHaveValue("regression");
  await page.locator("#password").click();
  await expect(page.locator("#password")).toBeFocused();
  await page.locator("#password").fill(password);
  await expect(page.locator("#password")).toHaveValue(password);
  await page.locator('button[type="submit"]').click();
  await expect(page).not.toHaveURL(/\/login/);
  const cookies = await page.context().cookies();
  expect(
    cookies.some((cookie) => cookie.httpOnly && cookie.sameSite === "Lax"),
  ).toBeTruthy();
  await page.goto("/articles");
  await expect(page.locator("#articles-view")).toBeVisible();
});

test("footer read action waits for success, returns to overview, and preserves the top toggle (PR 20)", async ({
  page,
}) => {
  await owner(page);
  let fail = true;
  await page.route(`**/api/articles/${articleId}`, (route) =>
    route.fulfill({
      status: fail ? 500 : 200,
      json: fail
        ? { error: "Opslaan mislukt" }
        : { id: articleId, readAt: new Date().toISOString() },
    }),
  );
  const footer = page.locator("[data-return-to-articles]");
  await footer.click();
  await expect(page.locator("#article-read-footer-status")).toHaveText(
    "Opslaan mislukt",
  );
  await expect(page).toHaveURL(new RegExp(`#job=${articleId}`));
  await expect(footer).toBeEnabled();
  fail = false;
  await page.locator("[data-article-read-toggle]").first().click();
  await expect(page).toHaveURL(new RegExp(`#job=${articleId}`));
  await page.reload();
  await expect(
    page.locator("[data-article-read-toggle]").first(),
  ).toHaveAttribute("aria-pressed", "false");
  await footer.click();
  await expect(page).toHaveURL(/\/articles$/);
  await expect(page.locator("#articles-view")).toBeVisible();
  await expect(page.getByRole("progressbar")).toBeHidden();
});

test("source checks and contents navigation preserve article identity (PR 36)", async ({
  page,
}) => {
  await owner(page);
  if (await page.locator("#toc a").nth(1).isVisible()) {
    await page.locator("#toc a").nth(1).click();
  } else {
    const href = await page.locator("#toc a").nth(1).getAttribute("href");
    await page.goto(`/${href}`);
  }
  await expect(page).toHaveURL(new RegExp(`job=${articleId}&section=`));
  await page.reload();
  await expect(page.locator("#article > h1")).toBeVisible();
  const citation = page.locator("#article section .source-link").nth(2);
  await citation.scrollIntoViewIfNeeded();
  const before = await page.evaluate(() => scrollY);
  await citation.click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("dialog")).toContainText(
    "Meer rust geeft ruimte voor aandacht.",
  );
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(citation).toBeFocused();
  expect(await page.evaluate(() => scrollY)).toBeCloseTo(before, 0);
});

test("transcript no-results recovery restores content and keyboard focus (PR 39)", async ({
  page,
}) => {
  await owner(page);
  await expect(page.locator("#toggle-transcript")).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await page.locator("#transcript-search").fill("onvindbaar");
  await expect(page.locator("#transcript-empty")).toBeVisible();
  await page.locator("#clear-transcript-search").click();
  await expect(page.locator("#transcript-search")).toBeFocused();
  await expect(page.locator("#transcript-search")).toHaveValue("");
  await expect(page.locator("#transcript-empty")).toBeHidden();
  await expect(page.locator("#transcript-segments")).toContainText("Meer rust");
});

test("overview sorts same-day read timestamps and collapses the read shelf (PRs 9, 10)", async ({
  page,
}) => {
  await login(page);
  const base = {
    id: articleId,
    title: "Earlier",
    dek: "Aandacht",
    sourceName: "De werkweek",
    sourceType: "google-drive",
    readingTimeMinutes: 3,
    completedAt: "2026-09-01T10:00:00Z",
  };
  await page.route("**/api/articles", (route) =>
    route.fulfill({
      json: [
        { ...base, id: "earlier", readAt: "2026-09-01T09:00:00Z" },
        {
          ...base,
          id: "later",
          title: "Later",
          readAt: "2026-09-01T18:00:00Z",
        },
        { ...base, id: "unread", title: "Unread" },
      ],
    }),
  );
  await page.goto("/articles");
  const shelf = page.locator("details.article-shelf");
  await expect(shelf).not.toHaveAttribute("open");
  await expect(page.getByText("Later", { exact: true })).toBeHidden();
  await shelf.locator("summary").click();
  await expect(shelf.locator(".article-card-title")).toHaveText([
    "Later",
    "Earlier",
  ]);
  await expect(page.getByText("Unread", { exact: true })).toBeVisible();
});

test("deployment warning clears on recovery and is never requested by a permalink (PR 43)", async ({
  page,
}) => {
  await login(page);
  let failed = true;
  let requests = 0;
  await page.route("**/api/deployment-status", (route) => {
    requests += 1;
    return route.fulfill({ json: { failed } });
  });
  await page.goto("/articles");
  await expect(page.locator("#deployment-alert")).toBeVisible();
  failed = false;
  await page.reload();
  await expect(page.locator("#deployment-alert")).toBeHidden();
  const previousRequests = requests;
  await shared(page);
  await expect(page.locator("#deployment-alert")).toHaveCount(0);
  expect(requests).toBe(previousRequests);
});

test("mobile owner actions retain equal touch targets and visible read text (PR 4)", async ({
  page,
}) => {
  await owner(page);
  await page.setViewportSize({ width: 390, height: 844 });
  const actions = page.locator(".article-actions").first();
  const buttons = actions.locator("button");
  await expect(buttons).toHaveCount(3);
  const heights = await buttons.evaluateAll((elements) =>
    elements.map((element) => element.getBoundingClientRect().height),
  );
  expect(heights.every((height) => height >= 44)).toBeTruthy();
  expect(Math.max(...heights) - Math.min(...heights)).toBeLessThanOrEqual(1);
  await expect(
    actions.locator("[data-article-read-toggle] span"),
  ).toBeVisible();
  for (const selector of ["[data-pdf-export]", "[data-share-article]"]) {
    await expect(actions.locator(selector)).toHaveAccessibleName(/\S+/);
  }
});

test("shared resume uses device storage and never writes an owner reading position (PR 18)", async ({
  page,
}) => {
  await shared(page);
  const writes = [];
  page.on("request", (request) => {
    if (request.method() !== "GET") {
      writes.push(request.url());
    }
  });
  await page.evaluate(
    (token) =>
      localStorage.setItem(
        `podcast2article:reading-position:${token}`,
        JSON.stringify({ sectionIndex: 2 }),
      ),
    token,
  );
  await page.reload();
  const resume = page.locator("#continue-reading");
  await expect(resume).toBeVisible();
  await resume.click();
  const heading = page.locator("#article section > h2").nth(2);
  await expect
    .poll(async () => (await heading.boundingBox()).y)
    .toBeLessThan(100);
  await expect(resume).toBeHidden();
  expect(writes).toEqual([]);
});

test("composer selects have room for labels, arrows and keyboard focus (PR 13)", async ({
  page,
}) => {
  await login(page);
  await page.goto("/");
  const selects = page.locator(".options select");
  expect(await selects.count()).toBeGreaterThanOrEqual(2);
  for (const select of await selects.all()) {
    await select.focus();
    await expect(select).toBeFocused();
    const metrics = await select.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        height: element.getBoundingClientRect().height,
        padding: parseFloat(style.paddingRight),
        lineHeight: parseFloat(style.lineHeight),
        fontSize: parseFloat(style.fontSize),
      };
    });
    expect(metrics.height).toBeGreaterThanOrEqual(48);
    expect(metrics.padding).toBeGreaterThanOrEqual(40);
    expect(metrics.lineHeight).toBeGreaterThan(metrics.fontSize);
  }
  await noOverflow(page);
});

test("navigation fits at 320px without webfonts", async ({ page }) => {
  await owner(page);
  await page.setViewportSize({ width: 320, height: 844 });
  await expect(page.locator("#logout-form")).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Series", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Artikelen", exact: true }),
  ).toBeVisible();

  await expect
    .poll(() =>
      page
        .locator(".nav, .brand, .main-nav, .main-nav a, .main-nav button")
        .evaluateAll((elements) =>
          elements
            .filter((element) => {
              const bounds = element.getBoundingClientRect();
              return (
                bounds.width > 0 &&
                (bounds.left < 0 || bounds.right > innerWidth)
              );
            })
            .map((element) => element.textContent.trim()),
        ),
    )
    .toEqual([]);
});

test("article page fits at 320px without webfonts", async ({ page }) => {
  await owner(page);
  await page.setViewportSize({ width: 320, height: 844 });

  await noOverflow(page);
});

test("share feedback disappears after four seconds and restarts for a new action", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "share", { value: undefined });
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: async () => {} },
    });
  });
  await owner(page);
  await page.clock.install();
  const button = page.locator("[data-share-article]").first();
  const statuses = page.locator(
    "#article-action-status, #article-read-footer-status",
  );

  await button.click();

  await expect(statuses).toHaveText([
    "Deelbare link gekopieerd.",
    "Deelbare link gekopieerd.",
  ]);
  await page.clock.fastForward(3000);
  await button.click();
  await expect(button).toBeEnabled();
  await page.clock.fastForward(1000);
  await expect(statuses).toHaveText([
    "Deelbare link gekopieerd.",
    "Deelbare link gekopieerd.",
  ]);
  await page.clock.fastForward(3000);
  await expect(statuses).toHaveText(["", ""]);
});
