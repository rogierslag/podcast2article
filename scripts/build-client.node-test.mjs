import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { buildClient } from "./build-client.mjs";

test("client builds preserve script timing and CSS order with reproducible compressed assets", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "p2a-client-"));
  try {
    const publicDirectory = path.join(root, "public");
    await mkdir(publicDirectory);
    await writeFile(
      path.join(publicDirectory, "index.html"),
      `<script src="/settings.js"></script>
<link rel="stylesheet" href="/theme.css?v=old" />
<link rel="stylesheet" href="/reader.css" />
<script type="module" src="/app.js"></script>
<script src="/other.js" type="module"></script>
<h1>{{page.title}}</h1><style>.title { user-select: none; }</style>`,
    );
    await writeFile(
      path.join(publicDirectory, "settings.ts"),
      "const ready: boolean = true; window.ready = ready;",
    );
    await writeFile(
      path.join(publicDirectory, "common.ts"),
      "export function shared(): void { console.log('shared module'); }",
    );
    await writeFile(
      path.join(publicDirectory, "app.ts"),
      "import { shared } from './common.js'; shared();",
    );
    await writeFile(
      path.join(publicDirectory, "other.ts"),
      "import { shared } from './common.js'; shared();",
    );
    await writeFile(
      path.join(publicDirectory, "theme.css"),
      ".title { color: red; }",
    );
    await writeFile(
      path.join(publicDirectory, "reader.css"),
      ".title { color: blue; user-select: none; }",
    );

    await buildClient(root);

    const template = await readFile(
      path.join(root, "dist/client-templates/index.html"),
      "utf8",
    );
    assert.match(
      template,
      /<script src="\/assets\/settings-[\w-]+\.js"><\/script>/,
    );
    assert.match(
      template,
      /<script type="module" src="\/assets\/app-[\w-]+\.js">/,
    );
    assert.ok(
      template.indexOf("/assets/theme-") < template.indexOf("/assets/reader-"),
    );
    assert.ok(template.includes("{{page.title}}"));
    assert.ok(template.includes("-webkit-user-select"));
    assert.ok(!template.includes("?v=old"));
    const directory = path.join(root, "dist/client");
    const assets = JSON.parse(
      await readFile(
        path.join(root, "dist/client-templates/assets.json"),
        "utf8",
      ),
    );
    assert.equal(
      assets.filter((filename) => filename.startsWith("shared-")).length,
      1,
    );
    for (const filename of assets) {
      const code = await readFile(path.join(directory, filename));
      assert.deepEqual(
        brotliDecompressSync(
          await readFile(path.join(directory, filename + ".br")),
        ),
        code,
      );
      assert.deepEqual(
        gunzipSync(await readFile(path.join(directory, filename + ".gz"))),
        code,
      );
    }
    const firstBuild = await readdir(directory);

    await buildClient(root);

    assert.deepEqual(await readdir(directory), firstBuild);
    assert.equal(
      await readFile(
        path.join(root, "dist/client-templates/index.html"),
        "utf8",
      ),
      template,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
