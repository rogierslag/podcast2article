import { test, expect } from "@playwright/test";
import { articleId, password } from "./fixture.mjs";

const control = (page, name) => page.locator(`[data-narration="${name}"]`);
async function openArticle(page) {
  await page.goto(`/#job=${articleId}`);
  await expect(page.locator("#article > h1")).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await page.request.post("/login", {
    form: { username: "regression", password },
  });
  await page.request.patch(`/api/jobs/${articleId}/listening-position`, {
    data: { version: 1, passageIndex: 0 },
  });
  await page.addInitScript(() => {
    const synth = new EventTarget();
    synth.getVoices = () => [
      { name: "Daniel", voiceURI: "daniel", lang: "en-GB", localService: true },
      {
        name: "Test Nederlands",
        voiceURI: "test-nl",
        lang: "nl-NL",
        localService: true,
      },
    ];
    synth.speak = (utterance) => {
      window.testSpeech = utterance;
      window.speechRequests = (window.speechRequests || 0) + 1;
      utterance.onstart?.();
    };
    synth.cancel = () => {
      window.testSpeech = undefined;
    };
    Object.defineProperty(window, "speechSynthesis", { value: synth });
    window.SpeechSynthesisUtterance = class {
      constructor(text) {
        this.text = text;
      }
    };
  });
  await openArticle(page);
});

test("narration resumes account position after reload without changing read state", async ({
  page,
}) => {
  const before = await (
    await page.request.get(`/api/jobs/${articleId}`)
  ).json();
  await page.locator("[data-listen]").first().click();
  expect(await page.evaluate(() => window.testSpeech.text)).toBe(
    "When Better Ideas Arrive",
  );
  await page.evaluate(() => window.testSpeech.onend());
  await expect(page.locator("[data-listen]")).toContainText("%");
  await expect
    .poll(
      async () =>
        (await (await page.request.get(`/api/jobs/${articleId}`)).json())
          .listeningPosition.passageIndex,
    )
    .toBe(1);
  await page.reload();
  await expect(page.locator("[data-listen]").first()).toHaveText(
    /Verder · \d+%/,
  );
  expect(await page.evaluate(() => window.speechRequests || 0)).toBe(0);
  await page.locator("[data-listen]").first().click();
  expect(await page.evaluate(() => window.testSpeech.text)).toBe(
    "Een gesprek over aandacht en samenwerken.",
  );
  const after = await (await page.request.get(`/api/jobs/${articleId}`)).json();
  expect(after.readAt).toBe(before.readAt);
  expect(after.readingPosition).toEqual(before.readingPosition);
});

test("backgrounding cancels speech, ignores stale events, and requires an explicit resume", async ({
  page,
}) => {
  await page.locator("[data-listen]").first().click();
  await page.evaluate(() => {
    window.oldSpeech = window.testSpeech;
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: true,
    });
    document.dispatchEvent(new Event("visibilitychange"));
    window.oldSpeech.onend();
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: false,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(control(page, "status")).toContainText("Gepauzeerd");
  await expect(page.locator("[data-listen]").first()).toHaveText(
    /Verder · \d+%/,
  );
  expect(await page.evaluate(() => window.speechRequests)).toBe(1);
  await page.locator("[data-listen]").click();
  expect(await page.evaluate(() => window.testSpeech.text)).toBe(
    "When Better Ideas Arrive",
  );
});

test("source preview and navigation stop narration", async ({ page }) => {
  await page.locator("[data-listen]").last().click();
  await expect(page.locator("[data-listen]").first()).toHaveText(
    /Pauzeren · \d+%/,
  );
  await page.locator("#article [data-source]").first().click();
  await expect(control(page, "status")).toContainText("bron");
  expect(await page.evaluate(() => window.testSpeech)).toBeUndefined();
  await page.keyboard.press("Escape");
  await page.locator("[data-listen]").first().click();
  await page.evaluate(() => {
    location.hash = "";
  });
  await expect(page.locator("#result-view")).toBeHidden();
  expect(await page.evaluate(() => window.testSpeech)).toBeUndefined();
});

test("failed saving can be retried and a rewind cannot be overwritten by an older save", async ({
  page,
}) => {
  let fail = true;
  await page.route("**/listening-position", async (route) => {
    if (fail) {
      await route.fulfill({ status: 503, json: {} });
    } else {
      await route.continue();
    }
  });
  await page.locator("[data-listen]").first().click();
  await page.evaluate(() => window.testSpeech.onend());
  await expect(control(page, "saveError")).toBeVisible();
  fail = false;
  await control(page, "retry").click();
  await expect(control(page, "saveError")).toBeHidden();
  await expect
    .poll(
      async () =>
        (await (await page.request.get(`/api/jobs/${articleId}`)).json())
          .listeningPosition.passageIndex,
    )
    .toBe(1);
  await page.evaluate(() => window.testSpeech.onend());
  await page.locator("#article-narration summary").click();
  await control(page, "restart").click();
  await expect
    .poll(
      async () =>
        (await (await page.request.get(`/api/jobs/${articleId}`)).json())
          .listeningPosition.passageIndex,
    )
    .toBe(0);
});

test("voice choices, errors, unavailable voices, and narrow layout remain usable", async ({
  page,
}) => {
  await page.locator("[data-listen]").first().click();
  await page.locator("#article-narration summary").click();
  await control(page, "language").selectOption("en");
  await expect(control(page, "voice")).toHaveValue("daniel|Daniel|en-GB");
  await control(page, "speed").selectOption("1.2");
  await page.locator("[data-listen]").click();
  expect(await page.evaluate(() => window.testSpeech.rate)).toBe(1.2);
  await page.evaluate(() =>
    window.testSpeech.onerror({ error: "interrupted" }),
  );
  await expect(control(page, "status")).toContainText("gestopt");
  await page.locator("#article-narration summary").click();
  await control(page, "language").selectOption("fr");
  await expect(control(page, "unavailable")).toBeVisible();
  await expect(page.locator("[data-listen]")).toBeDisabled();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.emulateMedia({ media: "print" });
  await expect(page.locator("#article-narration")).toBeHidden();
});

test("the reader starts with one inline Listen button and keeps secondary controls hidden", async ({
  page,
}) => {
  await expect(page.locator("[data-listen]")).toHaveCount(1);
  await expect(page.locator("[data-listen]")).toHaveAccessibleName("Luisteren");
  await expect(page.locator("#article .byline [data-listen]")).toBeVisible();
  await expect(page.locator("#article-narration summary")).toBeHidden();
  await expect(control(page, "voice")).toBeHidden();
  await expect(control(page, "restart")).toBeHidden();
  await expect(control(page, "status")).toBeHidden();

  await page.locator("[data-listen]").click();

  await expect(page.locator("[data-listen]")).toHaveAccessibleName(
    "Pauzeren · 0%",
  );
  await expect(page.locator("#article-narration summary")).toBeVisible();
  await expect(control(page, "voice")).toBeHidden();
  await page.locator("#article-narration summary").click();
  await expect(control(page, "voice")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(control(page, "voice")).toBeHidden();
});

test("disabled narration stays hidden and never starts speech or saves progress", async ({
  page,
}) => {
  let saves = 0;
  await page.route("**/listening-position", async (route) => {
    saves += 1;
    await route.fulfill({ status: 404 });
  });
  await page.route("**/", async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      body: (await response.text()).replace(
        'data-browser-narration="true"',
        'data-browser-narration="false"',
      ),
    });
  });

  await page.reload();
  await expect(page.locator("#article > h1")).toBeVisible();

  await expect(page.locator("#article-narration")).toBeHidden();
  expect(await page.evaluate(() => window.speechRequests || 0)).toBe(0);
  expect(saves).toBe(0);
});
