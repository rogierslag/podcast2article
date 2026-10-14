import { test, expect } from "@playwright/test";
import { password } from "./fixture.mjs";
test.use({ video: "on" });

const previewId = "00000000-0000-4000-8000-000000000771";
const preview = {
  id: previewId,
  title: "De wetenschap van alledag",
  url: "https://example.com/podcast/feed.xml",
  count: 42,
  episodes: [
    { title: "Waarom slapen we? Een gesprek over ons geheugen" },
    { title: "Wat de Noordzee ons vertelt over het klimaat" },
    { title: "De stille revolutie in onze batterijen" },
  ],
};
for (const language of ["nl", "en"]) {
  test(`series: episode quick links prefill New article and wait for review in ${language}`, async ({
    page,
  }, testInfo) => {
    const sourceUrl =
      "https://example.com/podcast/why-we-sleep?episode=14&from=rss";
    let submissions = 0;
    const episodeEndpoint = `**/api/subscriptions/${previewId}/episodes/episode-14`;
    await page.route("**/api/subscriptions", (route) =>
      route.fulfill({
        json: [
          {
            id: previewId,
            title: "The Science of Everyday Life",
            paused: true,
            pauseReason: "limit",
            complete: 8,
            processing: 0,
            outstanding: 8,
            pendingCount: 2,
            archiveCount: 0,
            failed: [],
          },
        ],
      }),
    );
    await page.route(`**/api/subscriptions/${previewId}/episodes`, (route) =>
      route.fulfill({
        json: {
          feedAvailable: language === "en",
          episodes: [
            {
              key: "episode-14",
              title: "Why we sleep: a conversation about memory and attention",
              sourceUrl,
              publishedAt: "2026-10-10T12:00:00Z",
            },
            {
              key: "episode-15",
              title:
                language === "nl"
                  ? '<img src=x onerror="window.injected=true">'
                  : "What the North Sea tells us about a changing climate",
              sourceUrl: "https://example.com/next",
              publishedAt: "2026-10-11T12:00:00Z",
            },
          ],
        },
      }),
    );
    await page.route(episodeEndpoint, (route) => {
      if (route.request().method() === "POST") {
        submissions += 1;
        expect(route.request().postDataJSON()).toMatchObject({
          sourceUrl,
          language: "en",
          articleLength: "compact",
        });
        return route.fulfill({
          status: 400,
          json: { error: "Read articles before continuing." },
        });
      }
      return route.fulfill({
        json: {
          title: "Why we sleep",
          sourceUrl,
          language: "en",
          articleLength: "compact",
        },
      });
    });
    await page.goto("/series");
    await page.locator(`[data-ui-language="${language}"]`).click();
    const details = page.locator(".series-episodes");
    await details.locator("summary").click();
    const link = details.getByRole("link").first();
    await expect(link).toHaveText(
      "Why we sleep: a conversation about memory and attention",
    );
    await expect(details.locator("img")).toHaveCount(0);
    if (language === "nl") {
      await expect(details).toContainText(
        "Hieronder staan alleen opgeslagen wachtende afleveringen.",
      );
    }
    expect(await page.evaluate(() => window.injected)).toBeUndefined();
    await link.focus();
    await expect(link).toBeFocused();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    if (language === "en") {
      await page.screenshot({
        path: `/tmp/p2a-backlog-media/${testInfo.project.name}-quick-links.png`,
        fullPage: true,
      });
      await page.emulateMedia({ colorScheme: "dark" });
      await page.screenshot({
        path: `/tmp/p2a-backlog-media/${testInfo.project.name}-quick-links-dark.png`,
        fullPage: true,
      });
      await page.emulateMedia({ colorScheme: "light" });
    }

    await link.press("Enter");

    await expect(page.locator("#source-url")).toHaveValue(sourceUrl);
    await expect(page.locator("#job-form [name=language]")).toHaveValue("en");
    await expect(page.locator("#job-form [name=articleLength]")).toHaveValue(
      "compact",
    );
    await expect(page.locator("#source-prefill-note")).toBeVisible();
    expect(submissions).toBe(0);
    if (language === "en") {
      await page.screenshot({
        path: `/tmp/p2a-backlog-media/${testInfo.project.name}-episode-prefill.png`,
        fullPage: true,
      });
    }
    await page.locator("#job-form button[type=submit]").click();
    await expect(page.locator("#form-error")).toHaveText(
      "Read articles before continuing.",
    );
    expect(submissions).toBe(1);
  });
}
for (const language of ["nl", "en"]) {
  test(`series: backlog warning reflects capacity and pause state in ${language}`, async ({
    page,
  }, testInfo) => {
    let subscription = {
      id: previewId,
      title: "The Science of Everyday Life",
      paused: true,
      pauseReason: "limit",
      complete: 8,
      processing: 0,
      outstanding: 8,
      pendingCount: 10,
      archiveCount: 0,
      checkedAt: "2026-10-13T12:00:00Z",
      failed: [],
    };
    await page.route("**/api/subscriptions", (route) =>
      route.fulfill({ json: [subscription] }),
    );
    await page.goto("/series");
    await page.locator(`[data-ui-language="${language}"]`).click();

    const warning = page.locator(".series-backlog");
    await expect(warning).toContainText(
      language === "nl"
        ? "Je loopt achter: 10 afleveringen wachten."
        : "You’re falling behind: 10 episodes are waiting.",
    );
    await expect(warning).toContainText(
      language === "nl"
        ? "De oudste wachtende afleveringen worden eerst opgehaald."
        : "The oldest waiting episodes are fetched first.",
    );
    await expect(warning.getByRole("link")).toHaveAttribute(
      "href",
      "/articles",
    );
    await warning.getByRole("link").focus();
    await expect(warning.getByRole("link")).toBeFocused();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    if (language === "en") {
      await page.screenshot({
        path: `/tmp/p2a-backlog-media/${testInfo.project.name}-after.png`,
        fullPage: true,
      });
      await page.emulateMedia({ colorScheme: "dark" });
      await page.screenshot({
        path: `/tmp/p2a-backlog-media/${testInfo.project.name}-dark.png`,
        fullPage: true,
      });
      await page.emulateMedia({ colorScheme: "light" });
    }

    subscription = { ...subscription, pendingCount: 1 };
    await page.reload();
    await expect(warning).toContainText(
      language === "nl" ? "1 aflevering wacht." : "1 episode is waiting.",
    );
    subscription = { ...subscription, pauseReason: undefined };
    await page.reload();
    await expect(warning).toContainText(
      language === "nl" ? "handmatig gepauzeerd" : "manually paused",
    );
    subscription = { ...subscription, paused: false, outstanding: 7 };
    await page.reload();
    await expect(warning).toHaveCount(0);
    subscription = { ...subscription, pendingCount: 2 };
    await page.reload();
    await expect(warning).toBeVisible();
    subscription = { ...subscription, pendingCount: 0 };
    await page.reload();
    await expect(warning).toHaveCount(0);
  });
}
test.beforeEach(async ({ page }) => {
  await page.route(/^https?:\/\/(?!127\.0\.0\.1:4317)/, (route) =>
    route.abort(),
  );
  await page.request.post("/login", {
    form: { username: "regression", password },
  });
});
for (const language of ["nl", "en"]) {
  test(`series: controls allow seven outstanding episodes and stop at eight in ${language}`, async ({
    page,
  }) => {
    let outstanding = 5;
    await page.route("**/api/subscriptions", (route) =>
      route.fulfill({
        json: [
          {
            id: previewId,
            title: preview.title,
            paused: true,
            complete: outstanding,
            processing: 0,
            outstanding,
            pendingCount: 0,
            archiveCount: 3,
            failed: [],
          },
        ],
      }),
    );
    await page.goto("/series");
    await page.locator(`[data-ui-language="${language}"]`).click();
    const controls = page.locator(".series-control");
    await expect(controls.nth(0)).toBeEnabled();
    await expect(controls.nth(1)).toBeEnabled();

    outstanding = 7;
    await page.reload();
    await expect(controls.nth(0)).toBeEnabled();
    await expect(controls.nth(1)).toBeEnabled();
    await expect(controls.nth(1)).toContainText("1");
    await expect(page.locator(".series-item")).toContainText(
      language === "nl" ? "7 van maximaal 8" : "7 of at most 8",
    );

    outstanding = 8;
    await page.reload();
    await expect(controls.nth(0)).toBeDisabled();
    await expect(controls.nth(1)).toBeDisabled();
  });
}
test("series: a failed episode inventory can be retried without starting work", async ({
  page,
}) => {
  let attempts = 0;
  await page.route("**/api/subscriptions", (route) =>
    route.fulfill({
      json: [
        {
          id: previewId,
          title: "Public podcast",
          paused: false,
          complete: 0,
          processing: 0,
          outstanding: 0,
          pendingCount: 0,
          archiveCount: 0,
          failed: [],
        },
      ],
    }),
  );
  await page.route(`**/api/subscriptions/${previewId}/episodes`, (route) => {
    attempts += 1;
    return attempts === 1
      ? route.fulfill({ status: 500, json: { error: "Feed unavailable" } })
      : route.fulfill({ json: { feedAvailable: true, episodes: [] } });
  });
  await page.goto("/series");
  await page.locator(".series-episodes summary").click();
  await expect(page.locator(".series-episodes .error")).toHaveText(
    "Feed unavailable",
  );
  await page.locator(".series-episodes button").click();
  await expect(page.locator(".series-episodes")).toContainText(
    "Er zijn geen niet-ingeplande afleveringen beschikbaar",
  );
  expect(attempts).toBe(2);
});
test("series: episode quick links survive login and do not submit automatically", async ({
  page,
  context,
}) => {
  await context.clearCookies();
  const sourceUrl = "https://example.com/podcast/episode";
  const seriesEpisode = `${previewId}:episode-14`;
  await page.route(
    `**/api/subscriptions/${previewId}/episodes/episode-14`,
    (route) =>
      route.fulfill({
        json: {
          title: "Episode 14",
          sourceUrl,
          language: "en",
          articleLength: "compact",
        },
      }),
  );
  await page.goto(`/?${new URLSearchParams({ sourceUrl, seriesEpisode })}`);
  await expect(page).toHaveURL(/\/login\?/);
  await expect(page.locator("#username")).toBeFocused();
  await page.locator("#username").fill("regression");
  await page.locator("#password").fill(password);
  await page.locator("button[type=submit]").click();

  await expect(page.locator("#job-form [name=language]")).toHaveValue("en");
  await expect(page.locator("#job-form [name=articleLength]")).toHaveValue(
    "compact",
  );
  await expect(page.locator("#source-url")).toHaveValue(sourceUrl);
  expect(new URL(page.url()).searchParams.get("seriesEpisode")).toBe(
    seriesEpisode,
  );
});
test("series: preview, backlog confirmation and pause/resume remain usable on desktop and mobile", async ({
  page,
}, testInfo) => {
  let followed = false;
  let paused = false;
  let submitted;
  let outstanding = 8;
  await page.route("**/api/subscriptions**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname.endsWith("/discover")) {
      return route.fulfill({
        json: [{ title: preview.title, url: preview.url }],
      });
    }
    if (pathname.endsWith("/preview")) {
      return route.fulfill({ json: preview });
    }
    if (pathname.endsWith("/backfill")) {
      outstanding = 8;
      paused = true;
      return route.fulfill({ status: 202, json: { count: 3 } });
    }
    if (request.method() === "POST") {
      submitted = request.postDataJSON();
      followed = true;
      paused = true;
      return route.fulfill({ status: 202, json: { id: previewId } });
    }
    if (request.method() === "PATCH") {
      paused = request.postDataJSON().paused;
      return route.fulfill({ json: { paused } });
    }
    return route.fulfill({
      json: followed
        ? [
            {
              id: previewId,
              title: preview.title,
              paused,
              complete: 0,
              processing: outstanding,
              outstanding,
              archiveCount: 3,
              pauseReason: paused ? "limit" : undefined,
              pendingCount: 0,
              checkedAt: "2026-09-15T12:00:00Z",
              failed: [],
            },
          ]
        : [],
    });
  });
  await page.goto("/series");
  await expect(page.locator("#series-list")).toContainText(
    "Je volgt nog geen series",
  );
  await page
    .locator("#series-url")
    .fill("https://open.spotify.com/show/example");
  await page.getByRole("button", { name: "Zoek serie" }).click();
  await expect(page.locator("#series-preview-title")).toHaveText(preview.title);
  await expect(page.locator("#series-preview-title")).toBeFocused();
  await expect(page.locator("#series-backfill")).toHaveValue("none");
  await expect(page.locator("#series-backfill option")).toHaveCount(2);
  for (const [value, count] of [
    ["three", "3"],
    ["none", "0"],
    ["three", "3"],
  ]) {
    await page.locator("#series-backfill").selectOption(value);
    await expect(page.locator("#series-plan")).toContainText(
      `Je haalt ${count} afleveringen in`,
    );
  }
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    )
    .toBe(true);
  await testInfo.attach("series-preview", {
    body: await page.screenshot({ fullPage: true }),
    contentType: "image/png",
  });
  await page.getByRole("button", { name: "Bevestig en volg serie" }).click();
  await expect(page.locator("#series-status")).toContainText(
    "Serie toegevoegd",
  );
  expect(submitted).toEqual({
    previewId,
    backfill: "three",
    language: "auto",
    articleLength: "standard",
  });
  await expect(page.locator(".series-limit-note")).toContainText(
    "Automatisch gepauzeerd bij 8",
  );
  await expect(
    page.getByRole("button", { name: `Hervat: ${preview.title}`, exact: true }),
  ).toBeDisabled();
  await testInfo.attach("series-paused", {
    body: await page.screenshot({ fullPage: true }),
    contentType: "image/png",
  });
  // Simulate reading three articles through the existing reader, then refresh the list.
  outstanding = 5;
  await page.reload();
  await page
    .getByRole("button", { name: `Hervat: ${preview.title}`, exact: true })
    .click();
  await expect(page.locator(".series-state")).toHaveText("Actief");
  await page
    .getByRole("button", {
      name: `Haal tot 3 van de laatste 3 afleveringen op: ${preview.title}`,
      exact: true,
    })
    .click();
  await expect(page.locator("#series-status")).toContainText(
    "3 eerdere afleveringen ingepland",
  );
  await expect(
    page.getByRole("button", { name: `Hervat: ${preview.title}`, exact: true }),
  ).toBeDisabled();
});
test("series: errors are readable and untrusted titles are text", async ({
  page,
}) => {
  await page.route("**/api/subscriptions**", (route) => {
    if (route.request().method() === "GET") {
      return route.fulfill({ json: [] });
    }
    if (route.request().url().endsWith("/preview")) {
      return route.fulfill({
        json: {
          ...preview,
          title: '<img src=x onerror="window.injected=true">',
        },
      });
    }
    return route.fulfill({
      json: [{ title: preview.title, url: preview.url }],
    });
  });
  await page.goto("/series");
  await page.locator("#series-url").fill(preview.url);
  await page.getByRole("button", { name: "Zoek serie" }).click();
  await expect(page.locator("#series-preview-title")).toContainText("<img");
  expect(await page.evaluate(() => window.injected)).toBeUndefined();
  await page.route("**/api/subscriptions", (route) =>
    route.fulfill({
      status: 400,
      json: { error: "Dit voorbeeld is verlopen. Zoek de serie opnieuw op." },
    }),
  );
  await page.getByRole("button", { name: "Bevestig en volg serie" }).click();
  await expect(page.locator("#series-error")).toContainText(
    "Dit voorbeeld is verlopen",
  );
  await expect(page.locator("#series-error")).toBeFocused();
  await expect(
    page.getByRole("button", { name: "Bevestig en volg serie" }),
  ).toBeEnabled();
});
test("series: a Spotify show submitted on the landing page opens series setup", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .locator("#source-url")
    .fill("https://open.spotify.com/show/example");
  await page.locator('#job-form button[type="submit"]').click();
  await expect(page).toHaveURL(/\/series\?url=/);
  await expect(page.locator("#series-url")).toHaveValue(
    "https://open.spotify.com/show/example",
  );
});

test("series: single-row navigation shares the wordmark baseline", async ({
  page,
}) => {
  await page.setViewportSize({ width: 768, height: 1000 });
  await page.goto("/series");
  await expect(page.locator("#logout-form")).toBeVisible();
  await page.evaluate(() => document.fonts.ready);

  const baselines = await page
    .locator(".brand > span:last-child, .main-nav a")
    .evaluateAll((elements) =>
      elements
        .filter((element) => element.getBoundingClientRect().width)
        .map((element) => {
          // A zero-height inline box exposes the actual text baseline, not the glyph bounds.
          const original = [...element.childNodes];
          const text = document.createElement("span");
          const marker = document.createElement("i");
          marker.style.cssText =
            "display:inline-block;width:0;height:0;padding:0;margin:0;border:0";
          text.append(...original, marker);
          element.append(text);
          const baseline = marker.getBoundingClientRect().top;
          element.replaceChildren(...original);
          return baseline;
        }),
    );

  expect(baselines).toHaveLength(4);
  expect(Math.max(...baselines) - Math.min(...baselines)).toBeLessThan(0.5);
});

test("series: narrow navigation sits below the wordmark without overlap", async ({
  page,
}) => {
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/series");
    await expect(page.locator("#logout-form")).toBeVisible();
    await page.evaluate(() => document.fonts.ready);

    const brand = await page.locator(".brand").boundingBox();
    const navigation = await page.locator(".main-nav").boundingBox();
    expect(navigation.y).toBeGreaterThanOrEqual(brand.y + brand.height);
    expect(navigation.x + navigation.width).toBeLessThanOrEqual(width);
    await expect(page.locator('.main-nav a[href="/articles"]')).toBeVisible();
    await expect(page.locator('.main-nav a[href="/series"]')).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  }
});

test("series: covers and fallbacks render in discovery, preview and followed series", async ({
  page,
}, testInfo) => {
  const coverUrl = "http://127.0.0.1:4317/test-series-cover.svg";
  await page.route("**/test-series-cover.svg", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><rect width="400" height="400" fill="#254b48"/><circle cx="330" cy="80" r="140" fill="#dfba7b"/><text x="30" y="225" fill="#fff4dc" font-family="Georgia" font-size="46">Wetenschap</text><text x="30" y="280" fill="#fff4dc" font-family="Georgia" font-size="46">van alledag</text><path d="M30 320h220" stroke="#dfba7b" stroke-width="4"/></svg>',
    }),
  );
  await page.route("**/missing-series-cover.jpg", (route) =>
    route.fulfill({ status: 404, body: "" }),
  );
  const series = [
    { title: preview.title, imageUrl: coverUrl },
    { title: "Geschiedenis voor onderweg" },
    {
      title: "Een andere kijk op de wereld",
      imageUrl: "http://127.0.0.1:4317/missing-series-cover.jpg",
    },
  ];
  await page.route("**/api/subscriptions**", (route) => {
    if (route.request().url().endsWith("/discover")) {
      return route.fulfill({
        json: series.map((item) => ({ ...item, url: preview.url })),
      });
    }
    if (route.request().url().endsWith("/preview")) {
      return route.fulfill({ json: { ...preview, imageUrl: coverUrl } });
    }
    return route.fulfill({
      json: series.map((item, index) => ({
        ...item,
        id: String(index),
        paused: false,
        complete: 4,
        archiveCount: 0,
        processing: 0,
        pendingCount: 0,
        outstanding: 0,
        failed: [],
      })),
    });
  });
  await page.goto("/series");
  await expect(page.locator(".series-item")).toHaveCount(3);
  await expect(page.locator(".series-item img")).toHaveCount(1);
  await expect
    .poll(() =>
      page.locator(".series-item img").evaluate((image) => image.naturalWidth),
    )
    .toBe(400);
  await expect(page.locator(".series-cover").first()).toHaveAttribute(
    "aria-hidden",
    "true",
  );
  await page.locator("#series-url").fill(preview.url);
  await page.getByRole("button", { name: "Zoek serie" }).click();
  await expect(page.locator(".series-candidate")).toHaveCount(3);
  await expect(page.locator(".series-candidate img")).toHaveCount(1);
  await expect(
    page.getByRole("button", { name: preview.title, exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: `/tmp/p2a-series-${testInfo.project.name}-discovery.png`,
    fullPage: true,
  });
  await page.getByRole("button", { name: preview.title, exact: true }).click();
  await expect(page.locator("#series-preview-title")).toBeFocused();
  await expect(page.locator("#series-preview-cover img")).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    )
    .toBe(true);
  await page.screenshot({
    path: `/tmp/p2a-series-${testInfo.project.name}-preview.png`,
    fullPage: true,
  });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.screenshot({
    path: `/tmp/p2a-series-${testInfo.project.name}-dark.png`,
    fullPage: true,
  });
});

for (const language of ["nl", "en"]) {
  test(`series: controls align across subscriptions in ${language}`, async ({
    page,
  }, testInfo) => {
    await page.route("**/api/subscriptions", (route) =>
      route.fulfill({
        json: [
          {
            id: previewId,
            title: "The Pragmatic Engineer",
            paused: false,
            complete: 8,
            processing: 2,
            outstanding: 2,
            archiveCount: 3,
            pendingCount: 0,
            failed: [],
          },
          {
            id: "00000000-0000-4000-8000-000000000772",
            title: "StaffEng",
            paused: true,
            pauseReason: "limit",
            complete: 7,
            processing: 3,
            outstanding: 8,
            archiveCount: 3,
            pendingCount: 0,
            failed: [],
          },
        ],
      }),
    );
    await page.goto("/series");
    await page.locator(`[data-ui-language="${language}"]`).click();
    const buttons = page.locator(".series-control");
    await expect(buttons).toHaveCount(4);
    await expect(buttons.nth(2)).toBeDisabled();
    await expect(buttons.nth(3)).toBeDisabled();

    const assertAlignment = async () => {
      const boxes = await buttons.evaluateAll((elements) =>
        elements.map((element) => {
          const { x, width, height } = element.getBoundingClientRect();
          return { x, width, height };
        }),
      );
      for (const box of boxes) {
        expect(Math.abs(box.x - boxes[0].x)).toBeLessThan(1);
        expect(Math.abs(box.width - boxes[0].width)).toBeLessThan(1);
        expect(box.height).toBeGreaterThanOrEqual(44);
      }
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      if (page.viewportSize().width <= 600) {
        for (const item of await page.locator(".series-item").all()) {
          const content = await item
            .locator(":scope > div")
            .first()
            .boundingBox();
          const controls = await item.locator(".series-controls").boundingBox();
          expect(controls.x).toBe(content.x);
          expect(controls.width).toBe(content.width);
          expect(controls.y).toBeGreaterThanOrEqual(content.y + content.height);
        }
      }
    };
    await assertAlignment();
    await page.locator(".series-following").screenshot({
      path: testInfo.outputPath(`series-alignment-${language}.png`),
    });
    // The narrower desktop layout must keep the same column without overflowing.
    await page.setViewportSize({ width: 768, height: 1000 });
    await assertAlignment();
  });
}
