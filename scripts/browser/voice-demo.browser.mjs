import { test, expect } from "@playwright/test";
import { password } from "./fixture.mjs";

test.beforeEach(async ({ page }) => {
  await page.request.post("/login", {
    form: { username: "regression", password },
  });
  await page.addInitScript(() => {
    const synth = new EventTarget();
    synth.getVoices = () => [
      {
        name: "Test English",
        voiceURI: "test-en",
        lang: "en-GB",
        localService: true,
      },
      {
        name: "Test Dutch",
        voiceURI: "test-nl",
        lang: "nl-NL",
        localService: true,
      },
    ];
    synth.speak = (utterance) => {
      window.testUtterance = utterance;
      utterance.onstart?.();
    };
    synth.cancel = () => {
      window.testUtterance = undefined;
    };
    Object.defineProperty(window, "speechSynthesis", { value: synth });
    window.SpeechSynthesisUtterance = class {
      constructor(text) {
        this.text = text;
      }
    };
  });
  await page.goto("/voice-demo.html");
});

test("speech progress survives reload and pause repeats the interrupted passage", async ({
  page,
}) => {
  await page.locator("#text").fill("Eerste zin. Tweede zin. Derde zin.");
  await page.locator("#play").click();
  await expect(page.locator("#status")).toHaveText("Aan het voorlezen");
  await page.evaluate(() => window.testUtterance.onend());
  await expect(page.locator("#position")).toHaveText("1 / 3 passages voltooid");

  await page.locator("#pause").click();
  await page.locator("#play").click();
  expect(await page.evaluate(() => window.testUtterance.text)).toBe(
    "Tweede zin.",
  );
  await page.reload();
  await expect(page.locator("#position")).toHaveText("1 / 3 passages voltooid");
  await expect(page.locator("#status")).toHaveText(
    "Opgeslagen voortgang hersteld.",
  );
});

test("voice preview does not advance progress and stale completion cannot skip a passage", async ({
  page,
}) => {
  await page.locator("#text").fill("Eerste zin. Tweede zin.");
  await page.locator("#preview").click();
  await page.evaluate(() => window.testUtterance.onend());
  await expect(page.locator("#position")).toHaveText("0 / 2 passages voltooid");
  await page.locator("#play").click();
  await page.evaluate(() => {
    window.staleUtterance = window.testUtterance;
  });
  await page.locator("#pause").click();
  await page.evaluate(() => window.staleUtterance.onend());
  await expect(page.locator("#position")).toHaveText("0 / 2 passages voltooid");
});

test("errors preserve position, changing text resets it, and the layout fits", async ({
  page,
}) => {
  await page.locator("#next").click();
  await page.locator("#play").click();
  await page.evaluate(() =>
    window.testUtterance.onerror({ error: "voice-unavailable" }),
  );
  await expect(page.locator("#status")).toContainText("voice-unavailable");
  await expect(page.locator("#progress")).toHaveAttribute("value", "1");

  await page.locator("#text").fill("Nieuwe tekst.");
  await expect(page.locator("#position")).toHaveText("0 / 1 passages voltooid");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await expect(page.locator("#play")).toHaveAccessibleName(
    "Luisteren / doorgaan",
  );
});
