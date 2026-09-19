import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { translate } from "../public/i18n.js";

const articleId = "00000000-0000-4000-8000-000000000917";
const exhaustedArticleId = "00000000-0000-4000-8000-000000000919";
const token = "a".repeat(43);
const otherToken = "b".repeat(43);
const publicBaseUrl = "https://reads.example.test";
const episodeImage =
  "https://cdn.example.test/episode.jpg?crop=cover&width=1200";
const escapedFixtureText = "A <tag> \"quoted\" & 'apostrophe'";
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
  for (const [username, id, shareToken, title, audio] of [
    ["owner", articleId, token, "Intended article", audioBytes],
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
    ["--import", import.meta.resolve("tsx"), path.resolve("src/server.ts")],
    {
      cwd: directory,
      env: {
        ...process.env,
        PORT: String(port),
        GIT_SHA: "a".repeat(40),
        HOST: "127.0.0.1",
        OPENAI_API_KEY: "",
        APP_PASSWORD: "",
        SPENDING_LIMIT_EXEMPT_USERS: "other",
        PUBLIC_BASE_URL: `${publicBaseUrl}/`,
        APP_USERS: JSON.stringify({
          owner: "test-only-password-owner",
          other: "test-only-password-other",
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
    "A &lt;tag&gt; &quot;quoted&quot; &amp; &#39;apostrophe&#39;";

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
  assert.equal(other.article.title, "Other article");
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
