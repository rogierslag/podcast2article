import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { buildClient } from "./build-client.mjs";
import { translate } from "../public/i18n.js";

const articleId = "00000000-0000-4000-8000-000000000917";
const exhaustedArticleId = "00000000-0000-4000-8000-000000000919";
const token = "a".repeat(43);
const otherToken = "b".repeat(43);
const exampleToken = "_eUKVjs2CsydDZ7nEseiXUNRYc64L1Pp2EPQ8LLIGng";
const examplePath = `/s/${exampleToken}`;
const publicBaseUrl = "https://reads.example.test";
const episodeImage =
  "https://cdn.example.test/episode.jpg?crop=cover&width=1200";
const escapedFixtureText =
  "A </title><script>alert(1)</script> \"quoted\" & 'apostrophe'";
const audioBytes = Buffer.from("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ");
let directory;
let child;
let origin;

function tagAttribute(tag, name) {
  return tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];
}

function metaContent(markup, name) {
  const tags = [...markup.matchAll(/<meta\b[^>]*>/g)]
    .map(([tag]) => tag)
    .filter(
      (tag) =>
        tagAttribute(tag, "name") === name ||
        tagAttribute(tag, "property") === name,
    );
  assert.equal(tags.length, 1, `Expected one ${name} meta tag`);
  return tagAttribute(tags[0], "content");
}

function canonicalUrl(markup) {
  const tags = [...markup.matchAll(/<link\b[^>]*>/g)]
    .map(([tag]) => tag)
    .filter((tag) => tagAttribute(tag, "rel") === "canonical");
  assert.equal(tags.length, 1, "Expected one canonical link");
  return tagAttribute(tags[0], "href");
}

test("robots policy allows only the exact login and linked example URLs", async () => {
  const response = await fetch(`${origin}/robots.txt`);
  const rules = await response.text();
  const login = await fetch(`${origin}/login`);
  const markup = await login.text();

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /^text\/plain/);
  assert.equal(
    rules,
    `User-agent: *\nDisallow: /\nAllow: /login$\nAllow: ${examplePath}$\n`,
  );
  assert.ok(
    markup.includes(`href="https://reads.rogierslag.nl${examplePath}"`),
  );
  assert.equal(login.headers.get("x-robots-tag"), null);

  const example = await fetch(`${origin}${examplePath}`);
  assert.equal(example.status, 200);
  assert.equal(example.headers.get("x-robots-tag"), null);
  assert.equal(metaContent(await example.text(), "robots"), "index, follow");
});

test("other pages, APIs, audio and query variants remain non-indexable", async () => {
  const cookie = await loginAs("owner");
  const routes = [
    "/",
    "/articles",
    "/series",
    "/index.html",
    "/login.html",
    "/login?sourceUrl=https://example.com",
    "/login/",
    "/login?error=1",
    `${examplePath}?tracking=1`,
    `${examplePath}/`,
    `/s/${token}`,
    `/s/${otherToken}`,
    "/s/invalid",
    `/api/shared/${exampleToken}`,
    `/api/shared/${exampleToken}/audio`,
    `/api/shared/${token}`,
    `/api/shared/${token}/audio`,
    "/api/articles",
    "/api/jobs",
    "/share.js",
    "/styles.css",
    "/missing",
  ];

  for (const route of routes) {
    for (const headers of [{}, { cookie }]) {
      const response = await fetch(`${origin}${route}`, {
        redirect: "manual",
        headers,
      });

      assert.equal(
        response.headers.get("x-robots-tag"),
        "noindex, nofollow",
        route,
      );
      if (route.startsWith(examplePath) && response.status === 200) {
        assert.equal(
          metaContent(await response.text(), "robots"),
          "noindex, nofollow",
        );
      }
    }
  }
});

test("a deleted example remains a non-indexable public 404", async () => {
  const cookie = await loginAs("example");
  const deleted = await fetch(
    `${origin}/api/articles/00000000-0000-4000-8000-000000000920`,
    { method: "DELETE", headers: { cookie } },
  );
  assert.equal(deleted.status, 204);

  const response = await fetch(`${origin}${examplePath}`, {
    redirect: "manual",
  });

  assert.equal(response.status, 404);
  assert.equal(response.headers.get("location"), null);
  assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow");
  assert.equal(metaContent(await response.text(), "robots"), "noindex");
});

test("incoming links survive authentication and failed login without creating jobs", async () => {
  const sourceUrl =
    'https://open.spotify.com/episode/example?si=a&title="quoted"';
  const query = new URLSearchParams({ sourceUrl });

  const incoming = await fetch(`${origin}/?${query}`, { redirect: "manual" });
  assert.equal(incoming.status, 303);
  assert.equal(incoming.headers.get("location"), `/login?${query}`);
  const loginPage = await fetch(`${origin}/login?${query}`);
  const markup = await loginPage.text();
  assert.ok(markup.includes('name="sourceUrl"'));
  assert.ok(markup.includes("&amp;title=&quot;quoted&quot;"));

  const failed = await fetch(`${origin}/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      username: "owner",
      password: "wrong",
      sourceUrl,
    }),
  });
  assert.equal(failed.headers.get("location"), `/login?${query}&error=1`);

  const successful = await fetch(`${origin}/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      username: "owner",
      password: "test-only-password-owner",
      sourceUrl,
    }),
  });
  assert.equal(successful.headers.get("location"), `/?${query}`);
  const cookie = successful.headers.get("set-cookie").split(";")[0];
  const loggedIn = await fetch(`${origin}/login?${query}`, {
    redirect: "manual",
    headers: { cookie },
  });
  assert.equal(loggedIn.headers.get("location"), `/?${query}`);
  const jobs = await fetch(`${origin}/api/jobs`, { headers: { cookie } });
  assert.deepEqual(await jobs.json(), []);
});

test("login never redirects to incoming URL data or propagates malformed input", async () => {
  for (const sourceUrl of [
    "javascript:alert(1)",
    "//evil.example",
    "https://user:password@example.com",
    "x".repeat(501),
  ]) {
    const response = await fetch(
      `${origin}/?${new URLSearchParams({ sourceUrl })}`,
      { redirect: "manual" },
    );
    assert.equal(response.headers.get("location"), "/login");
  }
  const duplicate = await fetch(
    `${origin}/?sourceUrl=https://example.com&sourceUrl=https://other.example`,
    { redirect: "manual" },
  );
  assert.equal(duplicate.headers.get("location"), "/login");
});

function fixture(id, shareToken, title) {
  return {
    id,
    shareToken,
    sourceUrl: "https://example.com/recording",
    language: "nl",
    articleLength: "standard",
    stage: "complete",
    progress: 100,
    message: "Klaar",
    createdAt: "2026-09-06T10:00:00Z",
    updatedAt: "2026-09-06T10:00:00Z",
    readAt: "2026-09-06T11:00:00Z",
    apiUsage: {
      trackingStartedAt: "2026-09-06T10:00:00Z",
      coverage: "complete",
      requests: [{ requestId: "private-billing-request" }],
      knownEstimatedCostUsd: 0.42,
      unknownCostRequests: 0,
    },
    episode: {
      sourceType: "google-drive",
      sourceUrl: "https://example.com/recording",
      sourceName: "Test recording",
      title,
      mediaUrl: "https://example.com/private-media",
    },
    transcript: [
      {
        id: "t-00001",
        start: 5,
        end: 10,
        speaker: "Private speaker",
        text: "Private transcript text",
      },
    ],
    article: {
      title,
      dek: "A test article",
      readingTimeMinutes: 1,
      styleNote: "Clear",
      sections: [
        {
          heading: "First",
          paragraphs: [
            {
              kind: "paragraph",
              text: "Public article text",
              sources: ["t-00001"],
            },
          ],
        },
      ],
      takeaways: [],
    },
  };
}

before(async () => {
  // A hidden parent reproduces audio serving from Codex worktrees.
  directory = await mkdtemp(path.join(tmpdir(), ".p2a-reader-"));
  await cp(path.resolve("public"), path.join(directory, "public"), {
    recursive: true,
  });
  // Run the real file-serving route with an isolated client build, even in the standalone test job.
  await cp(path.resolve("src"), path.join(directory, "src"), {
    recursive: true,
  });
  await cp(path.resolve("package.json"), path.join(directory, "package.json"));
  await symlink(
    path.resolve("node_modules"),
    path.join(directory, "node_modules"),
    "dir",
  );
  await buildClient(directory);
  for (const name of ["client", "client-templates"]) {
    await cp(
      path.join(directory, "dist", name),
      path.join(directory, "src", name),
      { recursive: true },
    );
  }
  for (const [username, id, shareToken, title, audio] of [
    ["owner", articleId, token, "Intended article", audioBytes],
    [
      "example",
      "00000000-0000-4000-8000-000000000920",
      exampleToken,
      "Public example article",
      audioBytes,
    ],
    [
      "other",
      "00000000-0000-4000-8000-000000000918",
      otherToken,
      "Other article",
      Buffer.from("other recording"),
    ],
  ]) {
    const root = path.join(directory, "data", "users", username);
    await mkdir(path.join(root, "jobs"), { recursive: true });
    await mkdir(path.join(root, "media"), { recursive: true });
    const article = fixture(id, shareToken, title);
    if (id === articleId) {
      article.spotifyUrl = article.sourceUrl;
      article.episode.spotifyUrl = article.episode.sourceUrl;
      article.episode.podcast = article.episode.sourceName;
      article.episode.audioUrl = article.episode.mediaUrl;
      delete article.sourceUrl;
      delete article.episode.sourceUrl;
      delete article.episode.sourceName;
      delete article.episode.mediaUrl;
    }

    if (shareToken === otherToken) {
      article.shareAnalytics = {
        loads: 1,
        reads: 0,
        recentVisits: [
          {
            digest: createHash("sha256")
              .update("00000000-0000-4000-8000-000000000001")
              .digest("hex"),
            loadedAt: Date.now() - 31_000,
            read: false,
          },
        ],
      };
      article.episode.imageUrl = episodeImage;
      article.episode.title = escapedFixtureText;
      article.article.title = escapedFixtureText;
      article.article.dek = escapedFixtureText;
    }
    await writeFile(
      path.join(root, "jobs", `${id}.json`),
      JSON.stringify(article),
    );
    await writeFile(path.join(root, "media", `${id}.mp3`), audio);
  }
  const portReservation = createServer();
  await writeFile(
    path.join(
      directory,
      "data",
      "users",
      "owner",
      "jobs",
      `${exhaustedArticleId}.json`,
    ),
    JSON.stringify({
      ...fixture(exhaustedArticleId, "c".repeat(43), "Failed article"),
      article: undefined,
      stage: "failed",
      articleRetryAttempts: 2,
      error: "Article generation failed",
    }),
  );
  portReservation.listen(0, "127.0.0.1");
  await once(portReservation, "listening");
  const port = portReservation.address().port;
  await new Promise((resolve) => portReservation.close(resolve));
  origin = `http://127.0.0.1:${port}`;
  child = spawn(
    process.execPath,
    [
      "--import",
      import.meta.resolve("tsx"),
      path.join(directory, "src/server.ts"),
    ],
    {
      cwd: directory,
      env: {
        ...process.env,
        PORT: String(port),
        GIT_SHA: "a".repeat(40),
        HOST: "127.0.0.1",
        OPENAI_API_KEY: "",
        SPENDING_LIMIT_EXEMPT_USERS: "other",
        BROWSER_NARRATION_ENABLED: "true",
        BROWSER_NARRATION_USERS: "owner",
        PUBLIC_BASE_URL: `${publicBaseUrl}/`,
        APP_USERS: JSON.stringify({
          owner: "test-only-password-owner",
          other: "test-only-password-other",
          example: "test-only-password-example",
        }),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  await new Promise((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(
      () => reject(new Error(`Test server did not start: ${output}`)),
      20000,
    );
    const finish = (error) => {
      clearTimeout(timeout);
      error ? reject(error) : resolve();
    };
    child.once("error", finish);
    child.once("exit", (code) => {
      if (code) {
        finish(new Error(`Test server exited: ${output}`));
      }
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.includes("luistert op")) {
        finish();
      }
    });
  });
});

after(async () => {
  if (child && child.exitCode === null) {
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    await exited;
  }
  if (directory) {
    await rm(directory, { recursive: true, force: true });
  }
});

test("shared reader assets are public while owner routes require authentication", async () => {
  for (const route of [
    "/source-preview.js",
    "/share.js",
    "/styles.css",
    "/share.css",
    "/localize.js",
    "/i18n.js",
  ]) {
    assert.equal((await fetch(origin + route)).status, 200, route);
  }
  for (const route of [
    "/api/deployment-status",
    "/api/articles",
    "/api/subscriptions",
    "/api/subscriptions/article/00000000-0000-4000-8000-000000000931",
    "/api/subscriptions/preview",
    "/api/jobs",
    `/api/jobs/${articleId}/audio`,
  ]) {
    assert.equal((await fetch(origin + route)).status, 401, route);
  }
});

test("built assets negotiate compression and cache safely without exposing build files", async () => {
  const page = await fetch(`${origin}/login`);
  const markup = await page.text();
  const urls = [...markup.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map(
    ([, url]) => url,
  );
  assert.ok(urls.length > 0);

  for (const url of urls) {
    const plain = await fetch(origin + url, {
      headers: { "Accept-Encoding": "identity" },
    });
    assert.equal(plain.status, 200);
    assert.equal(plain.headers.get("content-encoding"), null);
    const content = await plain.text();
    for (const [accept, encoding] of [
      ["gzip", "gzip"],
      ["br, gzip", "br"],
      ["br;q=0, gzip;q=1", "gzip"],
    ]) {
      const compressed = await fetch(origin + url, {
        headers: { "Accept-Encoding": accept },
      });
      assert.equal(compressed.status, 200);
      assert.equal(compressed.headers.get("content-encoding"), encoding);
      assert.match(compressed.headers.get("vary"), /Accept-Encoding/i);
      assert.match(
        compressed.headers.get("cache-control"),
        /max-age=31536000.*immutable/,
      );
      assert.equal(await compressed.text(), content);
    }
    const head = await fetch(origin + url, {
      method: "HEAD",
      headers: { "Accept-Encoding": "br" },
    });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("content-encoding"), "br");
    assert.equal(await head.text(), "");
    assert.equal((await fetch(origin + url, { method: "POST" })).status, 404);
    const refused = await fetch(origin + url, {
      headers: { "Accept-Encoding": "identity;q=0, br;q=0, gzip;q=0" },
    });
    assert.equal(refused.status, 406);
  }
  for (const url of [
    "/assets/assets.json",
    "/assets/index.html",
    "/assets/missing.js",
    urls[0] + ".br",
    "/assets/%2e%2e%2fpackage.json",
  ]) {
    assert.equal(
      (await fetch(origin + url, { redirect: "manual" })).status,
      404,
      url,
    );
  }
});

test("job creation requires sourceUrl and rejects the removed Spotify-only input", async () => {
  const cookie = await loginAs("owner");
  const sourceUrl = "https://open.spotify.com/episode/example";
  const post = (body) =>
    fetch(`${origin}/api/jobs`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  assert.equal((await post({ spotifyUrl: sourceUrl })).status, 400);
  assert.equal((await post({})).status, 400);
  assert.equal((await post({ sourceUrl: "not a URL" })).status, 400);
  // Valid input reaches the disabled-processing guard without making paid requests.
  assert.equal((await post({ sourceUrl })).status, 503);
});

test("owner article responses normalize old source fields without returning aliases", async () => {
  const cookie = await loginAs("owner");
  const response = await fetch(`${origin}/api/jobs/${articleId}`, {
    headers: { Cookie: cookie },
  });
  const job = await response.json();

  assert.equal(response.status, 200);
  assert.equal(job.sourceUrl, "https://example.com/recording");
  assert.equal(job.episode.sourceName, "Test recording");
  assert.equal(job.episode.mediaUrl, "https://example.com/private-media");
  assert.equal(Object.hasOwn(job, "spotifyUrl"), false);
  for (const name of ["spotifyUrl", "podcast", "audioUrl"]) {
    assert.equal(Object.hasOwn(job.episode, name), false, name);
  }
});

test("brand images and icons are available without a session as actual image files", async () => {
  for (const [route, width, height] of [
    ["/social-card-nl.png", 1200, 630],
    ["/social-card-en.png", 1200, 630],
    ["/favicon-32.png", 32, 32],
    ["/apple-touch-icon.png", 180, 180],
    ["/icon-192.png", 192, 192],
    ["/icon-512.png", 512, 512],
  ]) {
    const response = await fetch(origin + route, { redirect: "manual" });
    const bytes = Buffer.from(await response.arrayBuffer());

    assert.equal(response.status, 200, route);
    assert.equal(response.headers.get("location"), null, route);
    assert.match(response.headers.get("content-type"), /^image\/png\b/, route);
    assert.deepEqual(
      bytes.subarray(0, 8),
      Buffer.from("89504e470d0a1a0a", "hex"),
      route,
    );
    assert.equal(bytes.readUInt32BE(16), width, route);
    assert.equal(bytes.readUInt32BE(20), height, route);
  }

  const icon = await fetch(`${origin}/favicon.ico`, { redirect: "manual" });
  const bytes = Buffer.from(await icon.arrayBuffer());
  assert.equal(icon.status, 200);
  assert.match(
    icon.headers.get("content-type"),
    /^image\/vnd\.microsoft\.icon\b/,
  );
  assert.deepEqual(bytes.subarray(0, 4), Buffer.from([0, 0, 1, 0]));
  assert.ok(bytes.readUInt16LE(4) > 0);

  const svg = await fetch(`${origin}/favicon.svg`, { redirect: "manual" });
  assert.equal(svg.status, 200);
  assert.match(svg.headers.get("content-type"), /^image\/svg\+xml\b/);
  assert.match(await svg.text(), /<svg\b/);
});

test("website previews use localized public branding without incoming query data", async () => {
  const cookie = await loginAs("owner");
  const query = new URLSearchParams({
    sourceUrl: "https://example.com/private-source-recording",
    error: "private-error-detail",
    job: articleId,
  });
  const imageDescriptions = new Map();

  for (const language of ["nl", "en"]) {
    for (const route of ["/login", "/"]) {
      const response = await fetch(`${origin}${route}?${query}`, {
        headers: {
          "Accept-Language": language,
          ...(route === "/" ? { Cookie: cookie } : {}),
        },
        redirect: "manual",
      });
      const markup = await response.text();
      const head = markup.slice(0, markup.indexOf("</head>"));
      const image = `${publicBaseUrl}/social-card-${language}.png`;

      assert.equal(response.status, 200, `${route} ${language}`);
      assert.equal(canonicalUrl(head), `${publicBaseUrl}/`);
      assert.equal(metaContent(head, "og:url"), `${publicBaseUrl}/`);
      assert.equal(metaContent(head, "og:type"), "website");
      assert.match(metaContent(head, "og:title"), /^Podcast2Article\b/);
      assert.equal(
        metaContent(head, "twitter:title"),
        metaContent(head, "og:title"),
      );
      assert.equal(
        metaContent(head, "og:description"),
        translate(language, "page.description"),
      );
      assert.equal(
        metaContent(head, "twitter:description"),
        metaContent(head, "og:description"),
      );
      assert.equal(metaContent(head, "og:image"), image);
      assert.equal(metaContent(head, "twitter:image"), image);
      assert.equal(metaContent(head, "twitter:card"), "summary_large_image");
      assert.equal(metaContent(head, "og:image:width"), "1200");
      assert.equal(metaContent(head, "og:image:height"), "630");
      assert.equal(metaContent(head, "og:image:type"), "image/png");
      const description = metaContent(head, "og:image:alt");
      assert.ok(description.length > 0);
      assert.equal(metaContent(head, "twitter:image:alt"), description);
      imageDescriptions.set(language, description);
      assert.doesNotMatch(
        head,
        /private-source-recording|private-error-detail/,
      );
      assert.equal(head.includes(articleId), false);
    }
  }
  assert.notEqual(imageDescriptions.get("nl"), imageDescriptions.get("en"));
});

test("articles without artwork use localized branding while preserving article identity and privacy", async () => {
  const imageDescriptions = new Map();
  for (const language of ["nl", "en"]) {
    const response = await fetch(`${origin}/s/${token}`, {
      headers: { "Accept-Language": language },
    });
    const markup = await response.text();
    const image = `${publicBaseUrl}/social-card-${language}.png`;

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "public, no-cache");
    assert.equal(metaContent(markup, "og:type"), "article");
    assert.equal(metaContent(markup, "og:title"), "Intended article");
    assert.equal(metaContent(markup, "og:description"), "A test article");
    assert.equal(canonicalUrl(markup), `${publicBaseUrl}/s/${token}`);
    assert.equal(metaContent(markup, "og:url"), `${publicBaseUrl}/s/${token}`);
    assert.equal(metaContent(markup, "og:image"), image);
    assert.equal(metaContent(markup, "twitter:image"), image);
    assert.equal(metaContent(markup, "twitter:card"), "summary_large_image");
    assert.equal(metaContent(markup, "og:image:width"), "1200");
    assert.equal(metaContent(markup, "og:image:height"), "630");
    assert.equal(metaContent(markup, "og:image:type"), "image/png");
    assert.ok(metaContent(markup, "og:image:alt").length > 0);
    imageDescriptions.set(language, metaContent(markup, "og:image:alt"));
    assert.equal(
      metaContent(markup, "twitter:image:alt"),
      metaContent(markup, "og:image:alt"),
    );
    assert.equal(metaContent(markup, "robots"), "noindex, nofollow");
    for (const privateValue of [
      articleId,
      "Private transcript text",
      "Private speaker",
      "private-media",
      "private-billing-request",
      "readAt",
      "articleRetryAttempts",
      "username",
    ]) {
      assert.equal(markup.includes(privateValue), false, privateValue);
    }
  }
  assert.notEqual(imageDescriptions.get("nl"), imageDescriptions.get("en"));
});

test("article artwork is preserved and untrusted preview fields are escaped", async () => {
  const response = await fetch(`${origin}/s/${otherToken}`);
  const markup = await response.text();
  const escapedImage = episodeImage.replaceAll("&", "&amp;");
  const escapedText =
    "A &lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt; &quot;quoted&quot; &amp; &#39;apostrophe&#39;";

  assert.equal(response.status, 200);
  assert.equal(metaContent(markup, "og:image"), escapedImage);
  assert.equal(metaContent(markup, "twitter:image"), escapedImage);
  assert.equal(metaContent(markup, "og:image:alt"), escapedText);
  assert.equal(metaContent(markup, "twitter:image:alt"), escapedText);
  assert.equal(metaContent(markup, "og:description"), escapedText);
  assert.equal(metaContent(markup, "twitter:description"), escapedText);
  assert.equal(metaContent(markup, "twitter:card"), "summary_large_image");
  assert.doesNotMatch(
    markup,
    /<meta property="og:image:(?:width|height|type)"/,
  );
  assert.equal(markup.includes(escapedFixtureText), false);
  assert.doesNotMatch(markup, /<script>alert\(1\)<\/script>/);
  assert.ok(markup.includes(`<title>${escapedText} — Podcast2Article</title>`));
});

test("series discovery, confirmation and mutations require an owner session", async () => {
  for (const [route, method] of [
    ["/api/subscriptions/discover", "POST"],
    ["/api/subscriptions/preview", "POST"],
    ["/api/subscriptions", "POST"],
    [
      "/api/subscriptions/00000000-0000-4000-8000-000000000771/backfill",
      "POST",
    ],
    ["/api/subscriptions/00000000-0000-4000-8000-000000000771", "PATCH"],
  ]) {
    const response = await fetch(origin + route, {
      method,
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(response.status, 401, route);
  }
  const page = await fetch(`${origin}/series`, { redirect: "manual" });
  assert.equal(page.status, 303);
  assert.equal(page.headers.get("location"), "/login");
});

test("invalid tokens return public 404s rather than login redirects", async () => {
  for (const invalid of ["invalid", "z".repeat(43)]) {
    for (const route of [
      `/s/${invalid}`,
      `/api/shared/${invalid}`,
      `/api/shared/${invalid}/audio`,
    ]) {
      const response = await fetch(origin + route, { redirect: "manual" });
      assert.equal(response.status, 404, route);
      assert.equal(response.headers.get("location"), null);
    }
  }
});

test("each public token returns only its own article and minimal source fields", async () => {
  const response = await fetch(`${origin}/api/shared/${token}`);
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(Object.keys(payload).sort(), [
    "article",
    "episode",
    "sources",
  ]);
  assert.equal(payload.article.title, "Intended article");
  assert.deepEqual(payload.sources, [{ id: "t-00001", start: 5 }]);
  for (const privateValue of [
    articleId,
    token,
    "Private transcript text",
    "Private speaker",
    "private-media",
    "apiUsage",
    "private-billing-request",
    "readAt",
    "articleRetryAttempts",
    "username",
  ]) {
    assert.equal(
      JSON.stringify(payload).includes(privateValue),
      false,
      privateValue,
    );
  }
  const other = await (
    await fetch(`${origin}/api/shared/${otherToken}`)
  ).json();
  assert.equal(other.article.title, escapedFixtureText);
});

test("public audio supports byte ranges without crossing the token boundary", async () => {
  const response = await fetch(`${origin}/api/shared/${token}/audio`, {
    headers: { Range: "bytes=4-9" },
  });

  assert.equal(response.status, 206);
  assert.equal(response.headers.get("accept-ranges"), "bytes");
  assert.equal(
    response.headers.get("content-range"),
    `bytes 4-9/${audioBytes.length}`,
  );
  assert.equal(await response.text(), "456789");
  assert.equal(
    await (await fetch(`${origin}/api/shared/${otherToken}/audio`)).text(),
    "other recording",
  );
});

test("authenticated audio supports seeking from a hidden workspace directory", async () => {
  const login = await fetch(`${origin}/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "username=owner&password=test-only-password-owner",
  });
  const cookie = login.headers.get("set-cookie").split(";")[0];

  const response = await fetch(`${origin}/api/jobs/${articleId}/audio`, {
    headers: { Cookie: cookie, Range: "bytes=10-13" },
  });

  assert.equal(response.status, 206);
  assert.equal(await response.text(), "ABCD");
  assert.equal(
    (
      await fetch(
        `${origin}/api/jobs/00000000-0000-4000-8000-000000000918/audio`,
        { headers: { Cookie: cookie } },
      )
    ).status,
    404,
  );
});

test("deployment failure is private, survives reads, and clears on recovery", async () => {
  const login = await fetch(`${origin}/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "username=owner&password=test-only-password-owner",
  });
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const statusFile = path.join(directory, "data/deployment-status.json");
  for (const failed of [true, true, false]) {
    await writeFile(
      statusFile,
      JSON.stringify({ failed, privateLog: "secret" }),
    );

    const response = await fetch(`${origin}/api/deployment-status`, {
      headers: { Cookie: cookie },
    });
    const shared = await fetch(`${origin}/api/shared/${token}`);

    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), { failed });
    assert.doesNotMatch(await shared.text(), /failed|deployment|secret/);
  }
  const page = await fetch(`${origin}/s/${token}`, {
    headers: { Cookie: cookie },
  });
  assert.doesNotMatch(await page.text(), /deployment-alert|deployment-status/);
  await rm(statusFile);
  const response = await fetch(`${origin}/api/deployment-status`, {
    headers: { Cookie: cookie },
  });
  assert.deepEqual(await response.json(), { failed: false });
});

async function loginAs(username) {
  const response = await fetch(`${origin}/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `username=${username}&password=test-only-password-${username}`,
  });
  return response.headers.get("set-cookie").split(";")[0];
}

test("saving a shared article requires a session and validates the capability", async () => {
  for (const method of ["GET", "POST"]) {
    assert.equal(
      (await fetch(`${origin}/api/saved-shares/${token}`, { method })).status,
      401,
    );
    const cookie = await loginAs("other");
    for (const invalid of ["invalid", "z".repeat(43)]) {
      assert.equal(
        (
          await fetch(`${origin}/api/saved-shares/${invalid}`, {
            method,
            headers: { Cookie: cookie },
          })
        ).status,
        404,
      );
    }
  }
});

test("saving creates one independent personal copy with only public content and working audio", async () => {
  const cookie = await loginAs("other");
  const headers = { Cookie: cookie };
  const endpoint = `${origin}/api/saved-shares/${token}`;
  assert.deepEqual(await (await fetch(endpoint, { headers })).json(), {
    articleId: null,
  });

  const results = await Promise.all(
    Array.from({ length: 4 }, async () => {
      const response = await fetch(endpoint, { method: "POST", headers });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store");
      return response.json();
    }),
  );
  const savedId = results[0].articleId;
  assert.notEqual(savedId, articleId);
  assert.ok(results.every((result) => result.articleId === savedId));
  assert.deepEqual(await (await fetch(endpoint, { headers })).json(), {
    articleId: savedId,
  });
  const saved = await (
    await fetch(`${origin}/api/jobs/${savedId}`, { headers })
  ).json();
  assert.equal(saved.article.title, "Intended article");
  assert.equal(saved.readAt, undefined);
  assert.equal(saved.shareToken, undefined);
  for (const privateValue of [
    articleId,
    token,
    "Private transcript text",
    "Private speaker",
    "private-media",
    "apiUsage",
    "private-billing-request",
  ]) {
    assert.equal(
      JSON.stringify(saved).includes(privateValue),
      false,
      privateValue,
    );
  }
  assert.equal(
    await (
      await fetch(`${origin}/api/jobs/${savedId}/audio`, { headers })
    ).text(),
    audioBytes.toString(),
  );
  const ownerHeaders = { Cookie: await loginAs("owner") };
  assert.equal(
    (await fetch(`${origin}/api/jobs/${savedId}`, { headers: ownerHeaders }))
      .status,
    404,
  );
  const ownSave = await (
    await fetch(endpoint, { method: "POST", headers: ownerHeaders })
  ).json();
  assert.equal(ownSave.articleId, articleId);
  const overview = await (
    await fetch(`${origin}/api/articles`, { headers })
  ).json();
  assert.ok(JSON.stringify(overview).includes(savedId));
});

test("completed articles reject regeneration with a localized conflict and retain their saved state", async () => {
  const cookie = await loginAs("owner");
  const file = path.join(
    directory,
    "data",
    "users",
    "owner",
    "jobs",
    `${articleId}.json`,
  );
  const saved = await readFile(file, "utf8");
  const endpoint = `${origin}/api/jobs/${articleId}`;
  const headers = { Cookie: cookie };
  const original = await (await fetch(endpoint, { headers })).json();

  for (const language of ["nl", "en"]) {
    const response = await fetch(`${endpoint}/retry-article`, {
      method: "POST",
      headers: { ...headers, "Accept-Language": language },
    });

    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      error: translate(language, "error.articleRetryNotFailed"),
    });
    assert.deepEqual(
      await (await fetch(endpoint, { headers })).json(),
      original,
    );
    assert.equal(await readFile(file, "utf8"), saved);
  }
});

test("exhausted article retries return a localized conflict without changing the saved job", async () => {
  const cookie = await loginAs("owner");
  const file = path.join(
    directory,
    "data",
    "users",
    "owner",
    "jobs",
    `${exhaustedArticleId}.json`,
  );
  const saved = await readFile(file, "utf8");
  const endpoint = `${origin}/api/jobs/${exhaustedArticleId}`;

  for (const language of ["nl", "en"]) {
    const response = await fetch(`${endpoint}/retry-article`, {
      method: "POST",
      headers: {
        Cookie: cookie,
        "Accept-Language": language,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ articleRetryAttempts: 0 }),
    });

    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      error: translate(language, "error.articleRetryLimit"),
    });
    assert.equal(await readFile(file, "utf8"), saved);
  }
});

test("owner permalink creation reuses the same capability and rejects another account (PR 3)", async () => {
  const cookie = await loginAs("owner");
  const otherCookie = await loginAs("other");
  const otherId = "00000000-0000-4000-8000-000000000918";
  const route = `${origin}/api/jobs/${otherId}/share`;

  const first = await fetch(route, {
    method: "POST",
    headers: { Cookie: otherCookie },
  });
  const second = await fetch(route, {
    method: "POST",
    headers: { Cookie: otherCookie },
  });
  const unauthorized = await fetch(route, {
    method: "POST",
    headers: { Cookie: cookie },
  });

  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  assert.deepEqual(await first.json(), await second.json());
  assert.equal(unauthorized.status, 404);
});

test("account budget requires a session and exposes only that account's summary", async () => {
  const anonymous = await fetch(`${origin}/api/account-budget`);
  assert.equal(anonymous.status, 401);
  const ownerCookie = await loginAs("owner");
  const ownerResponse = await fetch(
    `${origin}/api/account-budget?username=other`,
    { headers: { Cookie: ownerCookie } },
  );
  assert.equal(ownerResponse.headers.get("cache-control"), "no-store");
  const owner = await ownerResponse.json();
  assert.equal(owner.limitUsd, 5);
  assert.equal(owner.windowDays, 30);
  assert.equal(owner.remainingUsd, 5);
  assert.deepEqual(
    Object.keys(owner).sort(),
    [
      "windowDays",
      "spentUsd",
      "countedSpendUsd",
      "historicalSpendUsd",
      "reservedUsd",
      "unknownCostRequests",
      "limitUsd",
      "remainingUsd",
    ].sort(),
  );
  const otherCookie = await loginAs("other");
  const other = await (
    await fetch(`${origin}/api/account-budget`, {
      headers: { Cookie: otherCookie },
    })
  ).json();
  assert.equal(other.limitUsd, null);
  assert.equal(other.remainingUsd, null);
});

test("shared usage is persisted, deduplicated and visible only to its owner", async () => {
  const ownerCookie = await loginAs("owner");
  const otherCookie = await loginAs("other");
  const statsUrl = `${origin}/api/jobs/${articleId}/share-stats`;
  assert.equal((await fetch(statsUrl)).status, 401);
  assert.equal(
    (await fetch(statsUrl, { headers: { cookie: otherCookie } })).status,
    404,
  );
  const send = (
    shareToken,
    event,
    visitId = "00000000-0000-4000-8000-000000000001",
  ) =>
    fetch(`${origin}/api/shared/${shareToken}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event, visitId }),
    });
  assert.equal((await send("invalid", "load")).status, 404);
  assert.equal((await send("z".repeat(43), "load")).status, 404);
  assert.equal((await send(token, "invalid")).status, 400);
  assert.equal((await send(token, "load", "invalid")).status, 400);
  assert.equal((await send(token, "read")).status, 409);
  assert.equal((await send(token, "load")).status, 204);
  assert.equal((await send(token, "load")).status, 204);
  assert.equal((await send(token, "read")).status, 409);
  const stats = await (
    await fetch(statsUrl, { headers: { cookie: ownerCookie } })
  ).json();
  assert.equal(stats.loads, 1);
  assert.equal(stats.reads, 0);
  assert.deepEqual(Object.keys(stats).sort(), [
    "lastLoadedAt",
    "loads",
    "reads",
  ]);
  const stored = JSON.parse(
    await readFile(
      path.join(
        directory,
        "data",
        "users",
        "owner",
        "jobs",
        `${articleId}.json`,
      ),
      "utf8",
    ),
  );
  assert.equal(stored.shareAnalytics.loads, 1);
  const publicData = await (
    await fetch(`${origin}/api/shared/${token}`)
  ).json();
  assert.equal(publicData.shareAnalytics, undefined);
  assert.equal((await fetch(`${origin}/share-analytics.js`)).status, 200);
  // A receipt loaded from disk still accepts its read once after a restart.
  assert.equal((await send(otherToken, "read")).status, 204);
  assert.equal((await send(otherToken, "read")).status, 204);
  const otherStats = await (
    await fetch(
      `${origin}/api/jobs/00000000-0000-4000-8000-000000000918/share-stats`,
      { headers: { cookie: otherCookie } },
    )
  ).json();
  assert.equal(otherStats.loads, 1);
  assert.equal(otherStats.reads, 1);
});

test("unknown pages redirect to the article overview after authentication", async () => {
  const cookie = await loginAs("owner");

  for (const route of [
    "/_healthcheck",
    "/missing/nested?foo=bar",
    "/missing.html",
  ]) {
    for (const method of ["GET", "HEAD"]) {
      const response = await fetch(origin + route, {
        method,
        headers: { cookie },
        redirect: "manual",
      });

      assert.equal(response.status, 302, route);
      assert.equal(response.headers.get("location"), "/articles", route);
    }
  }
  const overview = await fetch(`${origin}/articles`, { headers: { cookie } });
  assert.equal(overview.status, 200);
  assert.match(await overview.text(), /id="articles-view"/);

  for (const route of [
    "/_healthcheck",
    "/missing/nested",
    "/missing.html",
    "/articles",
  ]) {
    const anonymous = await fetch(origin + route, {
      redirect: "manual",
    });

    assert.equal(anonymous.status, 303, route);
    assert.equal(anonymous.headers.get("location"), "/login", route);
  }
});

test("unknown API routes, shared paths and unsupported methods do not redirect", async () => {
  const cookie = await loginAs("owner");

  for (const [method, route] of [
    ["GET", "/api/missing"],
    ["GET", "/api/missing.html"],
    ["GET", "/s/invalid/extra"],
    ["POST", "/missing"],
    ["POST", "/missing.html"],
  ]) {
    const response = await fetch(origin + route, {
      method,
      headers: { cookie },
      redirect: "manual",
    });

    assert.equal(response.status, 404, route);
    assert.equal(response.headers.get("location"), null, route);
  }
});

test("public health preserves availability and exposes only deployment freshness fields", async () => {
  const statusFile = path.join(directory, "data/deployment-status.json");
  await writeFile(
    statusFile,
    JSON.stringify({
      failed: true,
      phase: "failed",
      targetCommit: "b".repeat(40),
      lastCheckedAt: Date.now(),
      targetObservedAt: Date.now() - 60_000,
      logs: "private-secret",
    }),
  );

  const response = await fetch(`${origin}/api/health`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(body.ok, true);
  assert.equal(body.deployment.status, "delayed");
  assert.equal(body.deployment.runningCommit, "a".repeat(40));
  assert.deepEqual(Object.keys(body.deployment).sort(), [
    "lastCheckedAt",
    "runningCommit",
    "status",
    "targetCommit",
  ]);
  assert.doesNotMatch(JSON.stringify(body), /private-secret|failed|logs/);
  await rm(statusFile);
});

test("retired narration routes and assets remain unavailable with old flags set", async () => {
  const cookie = await loginAs("owner");
  const headers = { Cookie: cookie };

  for (const route of [
    "/voice-demo",
    "/voice-demo.html",
    "/voice-demo.js",
    "/voice-demo.css",
    "/article-narration.js",
    "/article-speech-text.js",
  ]) {
    const response = await fetch(`${origin}${route}`, {
      headers,
      redirect: "manual",
    });
    assert.equal(response.status, 302, route);
    assert.equal(response.headers.get("location"), "/articles");
  }
  const progress = await fetch(
    `${origin}/api/jobs/${articleId}/listening-position`,
    {
      method: "PATCH",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ version: 1, passageIndex: 0 }),
    },
  );
  assert.equal(progress.status, 404);
  const page = await fetch(`${origin}/`, { headers });
  assert.equal(page.status, 200);
  assert.doesNotMatch(
    await page.text(),
    /article-narration|data-browser-narration|article-speech-text/,
  );
});

test("public assets and owner audio reject paths outside their fixed roots", async () => {
  const cookie = await loginAs("owner");
  for (const route of [
    "/%2e%2e%2fpackage.json",
    "/styles.css%2f..%2f..%2fpackage.json",
    "/api/jobs/%2e%2e%2foutside/audio",
    "/api/jobs/------------------------------------/audio",
    "/api/jobs/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/audio",
  ]) {
    const response = await fetch(origin + route, {
      headers: { Cookie: cookie },
      redirect: "manual",
    });

    assert.notEqual(response.status, 200, route);
    assert.doesNotMatch(await response.text(), /"dependencies"|"APP_USERS"/);
  }
});

test("successful logins do not consume the failed-login quota, which blocks correct credentials too", async () => {
  const headers = {
    "Content-Type": "application/x-www-form-urlencoded",
    "X-Forwarded-For": "192.0.2.10",
  };
  const login = (password) =>
    fetch(`${origin}/login`, {
      method: "POST",
      headers,
      body: new URLSearchParams({ username: "owner", password }),
      redirect: "manual",
    });
  for (let attempt = 0; attempt < 6; attempt++) {
    assert.ok(
      (await login("test-only-password-owner")).headers.get("set-cookie"),
    );
  }
  for (let attempt = 0; attempt < 5; attempt++) {
    assert.equal((await login("incorrect password")).status, 303);
  }

  const blocked = await login("test-only-password-owner");

  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers.get("set-cookie"), null);
  assert.ok(Number(blocked.headers.get("retry-after")) > 0);
  assert.equal(blocked.headers.get("cache-control"), "no-store");
});

test("concurrent failed logins cannot bypass the five-attempt limit", async () => {
  const responses = await Promise.all(
    Array.from({ length: 10 }, () =>
      fetch(`${origin}/login`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "X-Forwarded-For": "192.0.2.11",
        },
        body: new URLSearchParams({
          username: "unknown",
          password: "incorrect password",
        }),
        redirect: "manual",
      }),
    ),
  );

  assert.equal(
    responses.filter((response) => response.status === 303).length,
    5,
  );
  assert.equal(
    responses.filter((response) => response.status === 429).length,
    5,
  );
  assert.ok(responses.every((response) => !response.headers.has("set-cookie")));
});

test("public file and API requests share a per-IP limit before route work", async () => {
  const markup = await (await fetch(`${origin}/login`)).text();
  const assetUrl = markup.match(/src="(\/assets\/[^"]+)"/)?.[1];
  assert.ok(assetUrl, "Expected a built asset on the login page");
  const headers = { "X-Forwarded-For": "192.0.2.20", "Accept-Language": "en" };
  for (let request = 0; request < 600; request++) {
    const response = await fetch(`${origin}/api/shared/invalid`, { headers });
    assert.equal(response.status, 404);
    await response.arrayBuffer();
  }

  for (const route of [
    "/styles.css",
    assetUrl,
    "/s/invalid",
    "/api/articles",
    "/login",
    "/hooks/openai",
  ]) {
    const response = await fetch(origin + route, { headers });
    assert.equal(response.status, 429, route);
    assert.ok(Number(response.headers.get("retry-after")) > 0);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(
      (await response.json()).error,
      translate("en", "error.requestRateLimit"),
    );
  }
  const malformedSubmission = await fetch(`${origin}/login`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: "{invalid json",
  });
  assert.equal(malformedSubmission.status, 429);
  assert.equal(
    (
      await fetch(`${origin}/styles.css`, {
        headers: { "X-Forwarded-For": "192.0.2.21" },
      })
    ).status,
    200,
  );
});

for (const limit of ["0", "-1", "1.5", "invalid", "1000001"]) {
  test(`invalid request quota fails startup before serving requests: ${limit}`, () => {
    const result = spawnSync(
      process.execPath,
      ["--import", import.meta.resolve("tsx"), path.resolve("src/server.ts")],
      {
        cwd: directory,
        env: {
          ...process.env,
          APP_USERS: "",
          OPENAI_API_KEY: "",
          REQUEST_RATE_LIMIT_PER_MINUTE: limit,
        },
        encoding: "utf8",
        timeout: 10_000,
      },
    );

    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /ZodError/);
    assert.doesNotMatch(result.stdout, /luistert op/);
  });
}
