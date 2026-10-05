import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  appendFile,
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
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

async function availablePort() {
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const { port } = reservation.address();
  await new Promise((resolve) => reservation.close(resolve));
  return port;
}

async function until(predicate, output) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await delay(100);
  }
  throw new Error(`Development reload timed out: ${output()}`);
}

function pageAssets(markup) {
  return [...new Set(markup.match(/\/assets\/[\w.-]+/g) ?? [])].sort();
}

test(
  "development reloads coherent login, owner and shared assets after frontend edits",
  { timeout: 60_000 },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "p2a-dev-regression-"));
    let child;
    let output = "";
    try {
      for (const entry of [
        "src",
        "public",
        "scripts",
        "package.json",
        "tsconfig.json",
      ]) {
        await cp(path.resolve(entry), path.join(root, entry), {
          recursive: true,
        });
      }
      await symlink(
        path.resolve("node_modules"),
        path.join(root, "node_modules"),
        "dir",
      );
      const id = "00000000-0000-4000-8000-000000000931";
      const token = "d".repeat(43);
      const jobs = path.join(root, "data/users/development/jobs");
      await mkdir(jobs, { recursive: true });
      await writeFile(
        path.join(jobs, `${id}.json`),
        JSON.stringify({
          id,
          shareToken: token,
          sourceUrl: "https://example.com/recording",
          language: "en",
          articleLength: "standard",
          stage: "complete",
          progress: 100,
          message: "Complete",
          createdAt: "2026-10-05T10:00:00Z",
          updatedAt: "2026-10-05T10:00:00Z",
          episode: {
            sourceType: "youtube",
            sourceUrl: "https://example.com/recording",
            sourceName: "Development recording",
            title: "Development article",
            mediaUrl: "https://example.com/audio",
          },
          transcript: [
            {
              id: "t-00001",
              start: 0,
              end: 1,
              speaker: "Speaker",
              text: "Development text.",
            },
          ],
          article: {
            title: "Development article",
            dek: "A development fixture",
            readingTimeMinutes: 1,
            styleNote: "Clear",
            sections: [
              {
                heading: "Development",
                paragraphs: [
                  { text: "Development text.", sources: ["t-00001"] },
                ],
              },
            ],
            takeaways: [],
          },
        }),
      );
      const origin = `http://127.0.0.1:${await availablePort()}`;
      child = spawn(process.execPath, ["scripts/dev.mjs"], {
        cwd: root,
        detached: true,
        env: {
          ...process.env,
          HOST: "127.0.0.1",
          PORT: new URL(origin).port,
          OPENAI_API_KEY: "",
          APP_USERS: JSON.stringify({ development: "test-only-password" }),
          PUBLIC_BASE_URL: "",
          REQUEST_RATE_LIMIT_PER_MINUTE: "500",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout.on("data", (chunk) => {
        output += chunk.toString();
      });
      child.stderr.on("data", (chunk) => {
        output += chunk.toString();
      });
      await until(
        async () => {
          try {
            return (await fetch(`${origin}/api/health`)).ok;
          } catch {
            return false;
          }
        },
        () => output,
      );
      const login = await fetch(`${origin}/login`, {
        method: "POST",
        redirect: "manual",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          username: "development",
          password: "test-only-password",
        }),
      });
      assert.equal(login.status, 303);
      const cookie = login.headers.get("set-cookie").split(";")[0];
      async function snapshot() {
        const pages = [];
        for (const [route, headers] of [
          ["/login", {}],
          ["/articles", { cookie }],
          [`/s/${token}`, {}],
        ]) {
          const response = await fetch(`${origin}${route}`, {
            headers,
            redirect: "manual",
          });
          if (!response.ok) {
            return undefined;
          }
          const assets = pageAssets(await response.text());
          if (!assets.length) {
            return undefined;
          }
          for (const asset of assets) {
            if (!(await fetch(`${origin}${asset}`)).ok) {
              return undefined;
            }
          }
          pages.push(assets);
        }
        const manifest = JSON.parse(
          await readFile(
            path.join(root, "dist/client-templates/assets.json"),
            "utf8",
          ),
        );
        for (const filename of manifest) {
          if (!(await fetch(`${origin}/assets/${filename}`)).ok) {
            return undefined;
          }
        }
        return pages;
      }
      const initial = await snapshot();
      assert.ok(initial);

      await appendFile(
        path.join(root, "public/theme.css"),
        "\n.development-regression { outline: 1px solid currentColor; }\n",
      );

      let afterStyles;
      await until(
        async () => {
          try {
            afterStyles = await snapshot();
            return (
              afterStyles &&
              afterStyles.every(
                (assets, index) =>
                  JSON.stringify(assets) !== JSON.stringify(initial[index]),
              )
            );
          } catch {
            return false;
          }
        },
        () => output,
      );
      assert.ok(afterStyles);

      await appendFile(
        path.join(root, "public/app.ts"),
        '\nconsole.info("Development TypeScript regression");\n',
      );

      let afterScript;
      await until(
        async () => {
          try {
            afterScript = await snapshot();
            return (
              afterScript &&
              JSON.stringify(afterScript[1]) !== JSON.stringify(afterStyles[1])
            );
          } catch {
            return false;
          }
        },
        () => output,
      );
      assert.ok(afterScript);

      const translationsPath = path.join(root, "src/shared/i18n.ts");
      const translations = await readFile(translationsPath, "utf8");
      assert.ok(translations.includes('en: "All articles."'));
      await writeFile(
        translationsPath,
        translations.replace(
          'en: "All articles."',
          'en: "Development articles."',
        ),
      );

      await until(
        async () => {
          try {
            const pages = await snapshot();
            if (
              !pages ||
              JSON.stringify(pages[1]) === JSON.stringify(afterScript[1])
            ) {
              return false;
            }
            const response = await fetch(`${origin}/articles`, {
              headers: { cookie, "Accept-Language": "en" },
            });
            return (
              response.ok &&
              (await response.text()).includes("Development articles.")
            );
          } catch {
            return false;
          }
        },
        () => output,
      );

      const scriptPath = path.join(root, "public/app.ts");
      const script = await readFile(scriptPath, "utf8");
      await appendFile(scriptPath, "\nconst brokenDevelopmentBuild = ;\n");
      await until(
        () => output.includes("Client build failed"),
        () => output,
      );

      await writeFile(scriptPath, script);

      await until(
        async () => {
          try {
            return Boolean(await snapshot());
          } catch {
            return false;
          }
        },
        () => output,
      );
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        process.kill(-child.pid, "SIGTERM");
        await exited;
      }
      await rm(root, { recursive: true, force: true });
    }
  },
);
