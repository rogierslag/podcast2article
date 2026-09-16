import { readFile } from "node:fs/promises";
import { test, expect } from "@playwright/test";
import { password } from "./fixture.mjs";

const sourceUrl =
  "https://open.spotify.com/episode/512ojhOuo1ktJprKbVcKyQ?si=sample&context=share";

test("shared link survives a failed login and waits for explicit submission", async ({
  page,
}) => {
  let submissions = 0;
  await page.route("**/api/jobs", async (route) => {
    if (route.request().method() === "POST") {
      submissions += 1;
      expect(route.request().postDataJSON()).toEqual({
        sourceUrl,
        language: "en",
        articleLength: "compact",
      });
      await route.fulfill({
        status: 503,
        json: { error: "Test submission received" },
      });
    } else {
      await route.continue();
    }
  });

  await page.goto(`/?${new URLSearchParams({ sourceUrl })}`);
  await expect(page).toHaveURL(/\/login\?/);
  await page.locator("#username").fill("regression");
  await page.locator("#password").fill("incorrect");
  await page.locator("button[type=submit]").click();
  await expect(page.locator("#login-error")).toBeVisible();
  await page.locator("#username").fill("regression");
  await page.locator("#password").fill(password);
  await page.locator("button[type=submit]").click();

  await expect(page.locator("#source-url")).toHaveValue(sourceUrl);
  await expect(page.locator("#source-prefill-note")).toBeVisible();
  expect(submissions).toBe(0);
  await page.locator("[name=language]").selectOption("en");
  await page.locator("[name=articleLength]").selectOption("compact");
  await page.locator("#job-form button[type=submit]").click();
  await expect(page.locator("#form-error")).toHaveText(
    "Test submission received",
  );
  expect(submissions).toBe(1);
});

test("installation help is keyboard accessible and provides the signed file", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "userAgent", {
      value: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)",
    });
  });
  await page.request.post("/login", {
    form: { username: "regression", password },
  });
  await page.goto("/");
  const summary = page.locator(".shortcut-install summary");
  await summary.focus();
  await page.keyboard.press("Enter");
  const link = page.getByRole("link", { name: "Download Add to Reads →" });
  await expect(link).toBeVisible();
  await expect(page.locator(".shortcut-install li")).toHaveCount(3);
  const response = await page.request.get(await link.getAttribute("href"));
  expect(response.ok()).toBeTruthy();
  expect(response.headers()["content-type"]).toContain(
    "application/x-apple-shortcut",
  );
  const downloadPromise = page.waitForEvent("download");
  await link.click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("Add to Reads.shortcut");
  expect(await readFile(await download.path())).toEqual(await response.body());
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await summary.focus();
  await page.keyboard.press("Enter");
  await expect(link).toBeHidden();
});

for (const [device, platform, userAgent, maxTouchPoints, visible] of [
  [
    "desktop Mac",
    "MacIntel",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)",
    0,
    false,
  ],
  [
    "Android phone",
    "Linux armv8l",
    "Mozilla/5.0 (Linux; Android 14) Mobile",
    5,
    false,
  ],
  ["Windows touchscreen", "Win32", "Mozilla/5.0 (Windows NT 10.0)", 10, false],
  [
    "iPad desktop mode",
    "MacIntel",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)",
    5,
    true,
  ],
]) {
  test(`installation UI visibility on ${device}`, async ({ page }) => {
    await page.addInitScript(
      (deviceProperties) => {
        for (const [name, value] of Object.entries(deviceProperties)) {
          Object.defineProperty(navigator, name, { value });
        }
      },
      { platform, userAgent, maxTouchPoints },
    );
    await page.request.post("/login", {
      form: { username: "regression", password },
    });

    await page.goto(`/?${new URLSearchParams({ sourceUrl })}`);
    await expect(page.locator("#source-url")).toHaveValue(sourceUrl);

    await expect(page.locator(".shortcut-install")).toBeVisible({ visible });
    await expect(page.locator(".android-install")).toBeVisible({
      visible: device === "Android phone",
    });
    if (!visible) {
      await expect(
        page.getByRole("link", { name: "Download Add to Reads →" }),
      ).toHaveCount(0);
    }
  });
}

test("unsafe links cannot populate or execute in the form", async ({
  page,
}) => {
  await page.request.post("/login", {
    form: { username: "regression", password },
  });
  await page.goto("/?sourceUrl=javascript%3Aalert(1)");
  await expect(page.locator("#source-url")).toHaveValue("");
  await expect(page.locator("#source-prefill-note")).toBeHidden();
});

test("Android text share survives login and manifest assets are public", async ({
  page,
}) => {
  const manifestResponse = await page.request.get("/manifest.webmanifest");
  expect(manifestResponse.headers()["content-type"]).toContain(
    "application/manifest+json",
  );
  const manifest = await manifestResponse.json();
  for (const icon of manifest.icons) {
    const response = await page.request.get(icon.src);
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("image/png");
  }
  expect(manifest.share_target.method).toBe("GET");
  const params = new URLSearchParams({
    [manifest.share_target.params.text]: `Listen to this episode\n${sourceUrl}`,
  });
  await page.goto(`${manifest.share_target.action}?${params}`);
  await expect(page).toHaveURL(/\/login\?/);
  await page.locator("#username").fill("regression");
  await page.locator("#password").fill(password);
  await page.locator("button[type=submit]").click();
  await expect(page.locator("#source-url")).toHaveValue(sourceUrl);
  await expect(page.locator("#source-prefill-note")).toBeVisible();
  expect((await page.request.get("/api/jobs")).ok()).toBe(true);
});

test("Android installation offers the browser prompt and hides after installation", async ({
  page,
}) => {
  await page.addInitScript(() =>
    Object.defineProperty(navigator, "userAgent", {
      value: "Mozilla/5.0 (Linux; Android 14) Chrome/130 Mobile",
    }),
  );
  await page.request.post("/login", {
    form: { username: "regression", password },
  });
  await page.goto("/");
  await expect(page.locator(".shortcut-install")).toBeHidden();
  const help = page.locator(".android-install");
  await expect(help).toBeVisible();
  await help.locator("summary").focus();
  await page.keyboard.press("Enter");
  const button = page.locator(".android-install-button");
  await expect(button).toBeHidden();
  await page.evaluate(() => {
    const event = new Event("beforeinstallprompt", { cancelable: true });
    event.prompt = async () => {
      document.body.dataset.installPrompted = "true";
    };
    window.dispatchEvent(event);
  });
  await expect(button).toBeVisible();
  await button.click();
  await expect(page.locator("body")).toHaveAttribute(
    "data-install-prompted",
    "true",
  );
  await expect(button).toBeHidden();
  await page.evaluate(() => window.dispatchEvent(new Event("appinstalled")));
  await expect(help).toBeHidden();
});

test("share target rejects unsafe and ambiguous inputs without granting API access", async ({
  page,
}) => {
  for (const text of [
    "javascript:alert(1)",
    "https://one.example https://two.example",
  ]) {
    const response = await page.request.get(
      `/share-target?${new URLSearchParams({ text })}`,
      { maxRedirects: 0 },
    );
    expect(response.status()).toBe(303);
    expect(response.headers().location).toBe("/");
  }
  expect((await page.request.get("/api/jobs")).status()).toBe(401);
  expect((await page.request.get("/api/articles")).status()).toBe(401);
});

test("installed Android windows hide setup help", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "userAgent", {
      value: "Mozilla/5.0 (Linux; Android 14) Chrome/130 Mobile",
    });
    const originalMatchMedia = window.matchMedia.bind(window);
    window.matchMedia = (query) => {
      const result = originalMatchMedia(query);
      if (query === "(display-mode: standalone)") {
        Object.defineProperty(result, "matches", { value: true });
      }
      return result;
    };
  });
  await page.request.post("/login", {
    form: { username: "regression", password },
  });
  await page.goto("/");

  await expect(page.locator(".android-install")).toBeHidden();
  await expect(page.locator(".shortcut-install")).toBeHidden();
});
