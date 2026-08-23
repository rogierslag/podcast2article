import { access } from "node:fs/promises";
import puppeteer, { type Browser } from "puppeteer-core";
import { createPasswordAuth, SESSION_COOKIE_NAME } from "./auth.js";

let browserPromise: Promise<Browser> | undefined;
const auth = createPasswordAuth();

function browserCandidates(): string[] {
  const configured = process.env.PDF_BROWSER_PATH?.trim();
  const candidates = configured ? [configured] : [];

  if (process.platform === "darwin") {
    candidates.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    );
  } else if (process.platform === "win32") {
    for (const root of [process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA]) {
      if (!root) continue;
      candidates.push(
        `${root}\\Google\\Chrome\\Application\\chrome.exe`,
        `${root}\\Chromium\\Application\\chrome.exe`,
        `${root}\\Microsoft\\Edge\\Application\\msedge.exe`,
      );
    }
  } else {
    candidates.push(
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/usr/bin/microsoft-edge",
    );
  }

  return candidates;
}

async function findBrowser(): Promise<string> {
  for (const candidate of browserCandidates()) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next conventional installation path.
    }
  }
  throw new Error("Geen Chrome-, Chromium- of Edge-installatie gevonden. Stel PDF_BROWSER_PATH in.");
}

async function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = findBrowser()
      .then((executablePath) => puppeteer.launch({ executablePath, headless: true }))
      .then((browser) => {
        browser.once("disconnected", () => {
          browserPromise = undefined;
        });
        return browser;
      })
      .catch((error) => {
        browserPromise = undefined;
        throw error;
      });
  }
  return browserPromise;
}

export function pdfDownloadName(title: string): string {
  const safeTitle = title
    .normalize("NFKC")
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim()
    .slice(0, 120);
  return `${safeTitle || "artikel"}.pdf`;
}

export async function generateArticlePdf(jobId: string, baseUrl: string): Promise<Uint8Array> {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    const session = auth.createSession();
    if (session) {
      await page.setCookie({
        name: SESSION_COOKIE_NAME,
        value: session,
        url: baseUrl,
        httpOnly: true,
        sameSite: "Strict",
      });
    }
    await page.goto(`${baseUrl}/#job=${encodeURIComponent(jobId)}`, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    await page.waitForSelector("#result-view:not(.hidden) #article h1", {
      visible: true,
      timeout: 30_000,
    });
    await page.evaluate(async () => {
      await Promise.race([
        (async () => {
          await document.fonts.ready;
          await Promise.all(Array.from(document.images, (image) => {
            if (image.complete) return Promise.resolve();
            return new Promise<void>((resolve) => {
              image.addEventListener("load", () => resolve(), { once: true });
              image.addEventListener("error", () => resolve(), { once: true });
            });
          }));
        })(),
        new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
      ]);
    });
    await page.emulateMediaType("print");
    return await page.pdf({
      format: "A4",
      preferCSSPageSize: true,
      printBackground: true,
    });
  } finally {
    await page.close();
  }
}

export async function shutdownPdfBrowser(): Promise<void> {
  const pending = browserPromise;
  browserPromise = undefined;
  if (!pending) return;
  const browser = await pending.catch(() => undefined);
  if (browser) await browser.close();
}
