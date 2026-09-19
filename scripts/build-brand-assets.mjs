import { readFile, writeFile } from "node:fs/promises";
import { chromium } from "@playwright/test";
import { translate } from "../public/i18n.js";

// Render checked-in assets explicitly; production builds do not need a browser.
// The installed Playwright Chromium and Google Fonts access are required here.
const theme = await readFile("public/theme.css", "utf8");
const palette = Object.fromEntries(
  ["cream", "ink", "green", "orange"].map((name) => {
    const value = theme.match(new RegExp(`--${name}:\\s*(#[\\da-f]+);`))?.[1];
    if (!value) {
      throw new Error(`Missing brand color: ${name}`);
    }
    return [name, value];
  }),
);
const index = await readFile("public/index.html", "utf8");
const headerMark = index.match(/<svg\s+class="brand-mark"[\s\S]*?<\/svg>/)?.[0];
if (!headerMark) {
  throw new Error("The owner header must contain the master brand mark");
}
const masterMark = headerMark.replaceAll(
  /var\(--(green|ink|orange)\)/g,
  (_, role) => palette[role],
);
const favicon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" role="img" aria-labelledby="title">
  <title id="title">Podcast2Article</title>
  <rect width="16" height="16" rx="2" fill="${palette.cream}"/>
  <g fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path stroke="${palette.green}" d="M2 6v4M5 3v10"/>
    <path stroke="${palette.orange}" d="M8 12V6q0-3 3-3h3"/>
    <path stroke="${palette.ink}" d="M11 12v-2q0-2 2-2h1"/>
  </g>
</svg>\n`;
const appIcon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-labelledby="title">
  <title id="title">Podcast2Article</title>
  <rect width="512" height="512" fill="${palette.cream}"/>
  ${masterMark.replace('width="48"', 'x="56" y="156" width="400"').replace('height="24"', 'height="200"')}
</svg>\n`;
await writeFile("public/favicon.svg", favicon);
await writeFile("public/app-icon.svg", appIcon);

function iconDocument(svg) {
  return `<html><head><style>*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden}body>svg{display:block;width:100%;height:100%}</style></head><body>${svg}</body></html>`;
}

// ICO accepts PNG frames. Keep 16, 32, and 48px frames for browser/platform choice.
function iconContainer(frames) {
  const header = Buffer.alloc(6 + frames.length * 16);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(frames.length, 4);
  let offset = header.length;
  for (const [index, { size, png }] of frames.entries()) {
    const position = 6 + index * 16;
    header[position] = size;
    header[position + 1] = size;
    header.writeUInt16LE(1, position + 4);
    header.writeUInt16LE(32, position + 6);
    header.writeUInt32LE(png.length, position + 8);
    header.writeUInt32LE(offset, position + 12);
    offset += png.length;
  }
  return Buffer.concat([header, ...frames.map(({ png }) => png)]);
}

function socialCard(language) {
  return `<!doctype html><html lang="${language}"><head><meta charset="utf-8">
    <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@500&family=Manrope:wght@700&family=Newsreader:opsz,wght@6..72,500;6..72,600&display=swap">
    <style>
      * { box-sizing: border-box; }
      body { margin: 0; width: 1200px; height: 630px; padding: 58px 64px; background: ${palette.cream}; color: ${palette.ink}; }
      .wordmark { font: 700 28px Manrope, sans-serif; letter-spacing: -1.3px; }
      .wordmark span { color: ${palette.orange}; }
      main { display: grid; grid-template-columns: 720px 300px; gap: 52px; align-items: center; margin-top: 94px; }
      .kicker { margin-bottom: 30px; color: ${palette.green}; font: 500 15px 'DM Mono', monospace; letter-spacing: 2px; text-transform: uppercase; }
      h1 { font: 600 108px/.94 Newsreader, serif; letter-spacing: -5px; margin: 0; }
      em { color: ${palette.orange}; font-weight: 500; }
      .symbol svg { display: block; width: 300px; height: 150px; }
      .symbol { padding-top: 38px; }
    </style></head><body>
    <div class="wordmark">Podcast<span>2</span>Article</div>
    <main><div><div class="kicker">${translate(language, "hero.kicker")}</div>
    <h1>${translate(language, "hero.start")}<br><em>${translate(language, "hero.end")}</em></h1></div>
    <div class="symbol">${masterMark}</div></main>
  </body></html>`;
}

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  const frames = [];
  for (const size of [16, 32, 48]) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(iconDocument(favicon));
    const png = await page.screenshot({ type: "png" });
    frames.push({ size, png });
    if (size === 32) {
      await writeFile("public/favicon-32.png", png);
    }
  }
  await writeFile("public/favicon.ico", iconContainer(frames));
  for (const [filename, size] of [
    ["apple-touch-icon.png", 180],
    ["icon-192.png", 192],
    ["icon-512.png", 512],
  ]) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(iconDocument(appIcon));
    await page.screenshot({ path: `public/${filename}` });
  }
  for (const language of ["nl", "en"]) {
    await page.setViewportSize({ width: 1200, height: 630 });
    await page.setContent(socialCard(language));
    await page.evaluate(async () => {
      await document.fonts.ready;
      for (const family of ["Newsreader", "Manrope", "DM Mono"]) {
        if (
          ![...document.fonts].some(
            (face) =>
              face.family.replaceAll('"', "") === family &&
              face.status === "loaded",
          )
        ) {
          throw new Error(`Preview font did not load: ${family}`);
        }
      }
    });
    await page.screenshot({ path: `public/social-card-${language}.png` });
  }
} finally {
  await browser.close();
}
console.log("Updated favicon, app icons, and Dutch/English social cards.");
