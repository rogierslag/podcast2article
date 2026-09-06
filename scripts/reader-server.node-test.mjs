import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

const articleId = "00000000-0000-4000-8000-000000000917";
const token = "a".repeat(43);
const otherToken = "b".repeat(43);
const audioBytes = Buffer.from("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ");
let directory;
let child;
let origin;

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
    await writeFile(
      path.join(root, "jobs", `${id}.json`),
      JSON.stringify(fixture(id, shareToken, title)),
    );
    await writeFile(path.join(root, "media", `${id}.mp3`), audio);
  }
  const portReservation = createServer();
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
        HOST: "127.0.0.1",
        OPENAI_API_KEY: "",
        APP_PASSWORD: "",
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
    "/api/articles",
    "/api/jobs",
    `/api/jobs/${articleId}/audio`,
  ]) {
    assert.equal((await fetch(origin + route)).status, 401, route);
  }
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
    "readAt",
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
