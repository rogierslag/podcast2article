import { test, expect } from "@playwright/test";
import {
  articleFixture,
  articleSummaryFixture,
  articleId,
  password,
  token,
} from "./fixture.mjs";

async function openOwner(page, savedSection) {
  const job = articleFixture();
  if (savedSection !== undefined) {
    job.readingPosition = {
      sectionIndex: savedSection,
      updatedAt: "2026-10-14T10:00:00Z",
    };
  }
  const writes = [];
  await page.request.post("/login", {
    form: { username: "regression", password },
  });
  await page.route(`**/api/jobs/${articleId}`, (route) =>
    route.fulfill({ json: job }),
  );
  await page.route(`**/api/jobs/${articleId}/reading-position`, (route) => {
    const position = route.request().postDataJSON();
    writes.push(position);
    job.readingPosition = { ...position, updatedAt: new Date().toISOString() };
    return route.fulfill({ json: { readingPosition: job.readingPosition } });
  });
  await page.goto(`/#job=${articleId}`);
  await expect(page.locator("#article > h1")).toHaveText(job.article.title);
  return { job, writes };
}

async function openShared(page, savedSection) {
  if (savedSection !== undefined) {
    await page.addInitScript(
      ({ token, savedSection }) => {
        localStorage.setItem(
          `podcast2article:reading-position:${token}`,
          JSON.stringify({ sectionIndex: savedSection }),
        );
      },
      { token, savedSection },
    );
  }
  await page.goto(`/s/${token}`);
  await expect(page.locator("#article > h1")).toHaveText(
    articleFixture().article.title,
  );
}

async function expectNoOwnerWrite(page, writes) {
  // Observe longer than the owner's scroll-settle and persistence debounce windows.
  await expect(
    page.waitForRequest(
      (request) =>
        request.method() === "PATCH" &&
        request.url().endsWith("/reading-position"),
      { timeout: 1200 },
    ),
  ).rejects.toThrow(/Timeout/);
  expect(writes).toEqual([]);
}

test.beforeEach(async ({ page }) => {
  await page.route(/^https?:\/\/(?!127\.0\.0\.1:4317)/, (route) =>
    route.abort(),
  );
});

test("owner reading input saves the settled section and survives reload", async ({
  page,
}, testInfo) => {
  const { writes } = await openOwner(page);
  await page.locator("#article > h1").click();

  if (testInfo.project.name === "desktop-chromium") {
    await page.keyboard.press("PageDown");
    await page.keyboard.press("PageDown");
  } else {
    // Playwright cannot generate native iOS swipes; exercise touch intent and the real browser scroll pipeline separately.
    await page.dispatchEvent("body", "touchmove");
    await page
      .locator("#article section > h2")
      .nth(2)
      .evaluate((heading) =>
        heading.scrollIntoView({ behavior: "instant", block: "start" }),
      );
  }
  await expect.poll(() => writes.length).toBeGreaterThan(0);
  const savedSection = writes.at(-1).sectionIndex;
  await expect(page.locator('#toc a[aria-current="location"]')).toHaveText(
    articleFixture().article.sections[savedSection].heading,
  );

  await page.reload();
  await expect(page.locator("#continue-reading")).toBeVisible();
  await expect(page.locator("#continue-reading-heading")).toHaveText(
    articleFixture().article.sections[savedSection].heading,
  );
});

test("owner wheel reading saves the final visible section", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop-chromium",
    "Native wheel input is a desktop interaction; simulator checks cover touch gestures.",
  );
  const { writes } = await openOwner(page);
  await page.mouse.move(700, 600);

  await page.mouse.wheel(0, 1500);
  await expect.poll(() => writes.length).toBeGreaterThan(0);

  const savedSection = writes.at(-1).sectionIndex;
  await expect(page.locator('#toc a[aria-current="location"]')).toHaveText(
    articleFixture().article.sections[savedSection].heading,
  );
});

test("owner programmatic scrolling and contents navigation keep the saved position", async ({
  page,
}) => {
  const { writes } = await openOwner(page, 3);
  const heading = page.locator("#article section > h2").nth(1);

  await heading.evaluate((element) =>
    element.scrollIntoView({ behavior: "instant", block: "start" }),
  );
  await expect(page.locator('#toc a[aria-current="location"]')).toHaveText(
    articleFixture().article.sections[1].heading,
  );
  await expectNoOwnerWrite(page, writes);

  await page.goto(
    `/#job=${articleId}&section=section-2-ruimte-voor-aandacht-3`,
  );
  await expect(page.locator('#toc a[aria-current="location"]')).toHaveText(
    articleFixture().article.sections[2].heading,
  );
  await expectNoOwnerWrite(page, writes);
});

test("owner Home and End keys do not overwrite the saved reading position", async ({
  page,
}) => {
  const { writes } = await openOwner(page, 2);
  await page.locator("#article > h1").click();

  await page.keyboard.press("End");
  await page.keyboard.press("Home");
  await expectNoOwnerWrite(page, writes);
});

test("marking read from the footer during resume cancels pending heading focus", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const { writes } = await openOwner(page, 3);
  await page.route(`**/api/articles/${articleId}`, (route) =>
    route.fulfill({
      json: {
        ...articleSummaryFixture(),
        readAt: "2026-10-14T10:00:00Z",
      },
    }),
  );
  await page.locator("#continue-reading").click();

  // Dispatch the existing footer action without scrolling away from the in-flight resume.
  await page.locator("[data-return-to-articles]").dispatchEvent("click");
  await expect(page.locator("#articles-view")).toBeVisible();
  await expectNoOwnerWrite(page, writes);
  await expect(page.locator("#article section > h2:focus")).toHaveCount(0);
});

for (const reader of ["owner", "shared"]) {
  for (const reducedMotion of ["reduce", "no-preference"]) {
    test(`${reader} resumes with ${reducedMotion} motion and focuses the heading`, async ({
      page,
    }) => {
      await page.emulateMedia({ reducedMotion });
      const writes =
        reader === "owner" ? (await openOwner(page, 2)).writes : [];
      if (reader === "shared") {
        await openShared(page, 2);
      }
      const heading = page.locator("#article section > h2").nth(2);

      await page.locator("#continue-reading").click();
      await expect(heading).toBeFocused();
      await expect
        .poll(async () => (await heading.boundingBox()).y)
        .toBeGreaterThanOrEqual(0);
      await expect
        .poll(async () => (await heading.boundingBox()).y)
        .toBeLessThan(120);
      await expect(page.locator("#continue-reading")).toBeHidden();
      if (reader === "owner") {
        await expectNoOwnerWrite(page, writes);
      }
    });
  }
}

test("shared scrolling persists locally without writing an owner position", async ({
  page,
}) => {
  const ownerWrites = [];
  page.on("request", (request) => {
    if (
      request.method() === "PATCH" &&
      request.url().includes("reading-position")
    ) {
      ownerWrites.push(request.url());
    }
  });
  await openShared(page);

  await page
    .locator("#article section > h2")
    .nth(2)
    .evaluate((heading) =>
      heading.scrollIntoView({ behavior: "instant", block: "start" }),
    );
  await expect
    .poll(() =>
      page.evaluate(
        (token) =>
          JSON.parse(
            localStorage.getItem(`podcast2article:reading-position:${token}`),
          )?.sectionIndex,
        token,
      ),
    )
    .toBe(2);
  await page.reload();

  await expect(page.locator("#continue-reading-heading")).toHaveText(
    articleFixture().article.sections[2].heading,
  );
  await expectNoOwnerWrite(page, ownerWrites);
});

test("changing owner articles during resume cannot focus the previous heading", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const { writes } = await openOwner(page, 3);
  const secondId = "00000000-0000-4000-8000-000000000932";
  const second = {
    ...articleFixture(),
    id: secondId,
    article: { ...articleFixture().article, title: "A second article" },
  };
  await page.route(`**/api/jobs/${secondId}`, (route) =>
    route.fulfill({ json: second }),
  );
  await page.locator("#continue-reading").click();

  await page.evaluate((id) => {
    location.hash = `#job=${id}`;
  }, secondId);
  await expect(page.locator("#article > h1")).toHaveText("A second article");
  await expect(page.locator(".resume-highlight")).toHaveCount(0);
  await expect(page.locator("#article section > h2:focus")).toHaveCount(0);
  await expectNoOwnerWrite(page, writes);
});

for (const reader of ["owner", "shared"]) {
  test(`${reader} recalculates progress after resizing the viewport`, async ({
    page,
  }) => {
    if (reader === "owner") {
      await openOwner(page);
    } else {
      await openShared(page);
    }
    await page
      .locator("#article section > h2")
      .nth(2)
      .evaluate((heading) =>
        heading.scrollIntoView({ behavior: "instant", block: "start" }),
      );

    const size = page.viewportSize();
    await page.setViewportSize({
      width: size.width,
      height: size.height + 200,
    });

    await expect
      .poll(async () => {
        const expected = await page.evaluate((reader) => {
          const article = document.querySelector("#article");
          const surface =
            reader === "owner"
              ? document.scrollingElement
              : document.querySelector(".page-scroll");
          const viewportTop =
            reader === "owner" ? 0 : surface.getBoundingClientRect().top;
          const height =
            reader === "owner" ? innerHeight : surface.clientHeight;
          const top =
            article.getBoundingClientRect().top -
            viewportTop +
            surface.scrollTop;
          const end = Math.max(top, top + article.offsetHeight - height);
          return Math.round(
            Math.min(1, Math.max(0, (surface.scrollTop - top) / (end - top))) *
              100,
          );
        }, reader);
        const actual = Number(
          await page.getByRole("progressbar").getAttribute("aria-valuenow"),
        );
        return actual - expected;
      })
      .toBe(0);
  });
}
