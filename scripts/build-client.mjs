import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { build } from "esbuild";
import { transform } from "lightningcss";

// These browsers support the reader's :has(), dialog, and dynamic viewport APIs.
export const browserTargets = [
  "chrome109",
  "edge109",
  "firefox121",
  "safari16.4",
];
const cssTargets = {
  chrome: 109 << 16,
  firefox: 121 << 16,
  safari: (16 << 16) | (4 << 8),
};

export async function buildClient(root = ".") {
  const sourceDirectory = path.resolve(root, "public");
  const outputDirectory = path.resolve(root, "dist/client");
  const legacyDirectory = path.resolve(root, "dist/client-legacy");
  const templateDirectory = path.resolve(root, "dist/client-templates");
  await rm(legacyDirectory, { recursive: true, force: true });
  await rm(outputDirectory, { recursive: true, force: true });
  await rm(templateDirectory, { recursive: true, force: true });
  await mkdir(outputDirectory, { recursive: true });
  await mkdir(templateDirectory, { recursive: true });

  const templates = new Map();
  const moduleEntries = new Set();
  const classicEntries = new Set();
  const stylesheets = new Set();
  for (const filename of await readdir(sourceDirectory)) {
    if (!filename.endsWith(".html")) {
      continue;
    }
    const template = await readFile(
      path.join(sourceDirectory, filename),
      "utf8",
    );
    templates.set(filename, template);
    for (const [tag, filename] of template.matchAll(
      /<script\b[^>]*\bsrc="\/(\w[\w-]*\.js)(?:\?[^"<>]*)?"[^>]*>/g,
    )) {
      (tag.includes('type="module"') ? moduleEntries : classicEntries).add(
        filename,
      );
    }
    for (const [, filename] of template.matchAll(
      /href="\/(\w[\w-]*\.css)(?:\?[^"<>]*)?"/g,
    )) {
      stylesheets.add(filename);
    }
  }

  const urls = new Map();
  const options = {
    bundle: true,
    plugins: [
      {
        name: "local-web-vitals",
        setup(builder) {
          builder.onResolve({ filter: /^\/vendor\/web-vitals\.js$/ }, () => ({
            path: fileURLToPath(import.meta.resolve("web-vitals")),
          }));
        },
      },
    ],
    minify: true,
    target: browserTargets,
    outdir: outputDirectory,
    entryNames: "[name]-[hash]",
    chunkNames: "shared-[hash]",
    metafile: true,
    legalComments: "none",
    logLevel: "silent",
  };
  const legacyEntries = {};
  for (const filename of await readdir(sourceDirectory)) {
    if (filename.endsWith(".ts") && !filename.endsWith(".d.ts")) {
      legacyEntries[path.basename(filename, ".ts")] = path.join(
        sourceDirectory,
        filename,
      );
    }
  }
  for (const name of ["i18n", "article-length", "source-prefill"]) {
    const sharedPath = path.resolve(root, "src/shared", `${name}.ts`);
    try {
      await readFile(sharedPath);
      legacyEntries[name] = sharedPath;
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
  }
  await build({
    ...options,
    entryPoints: legacyEntries,
    outdir: legacyDirectory,
    entryNames: "[name]",
    format: "esm",
  });
  for (const [entries, format, splitting] of [
    [moduleEntries, "esm", true],
    [classicEntries, "iife", false],
  ]) {
    const result = await build({
      ...options,
      entryPoints: [...entries].map((filename) =>
        path.join(sourceDirectory, filename.replace(/\.js$/, ".ts")),
      ),
      format,
      splitting,
    });
    for (const [output, metadata] of Object.entries(result.metafile.outputs)) {
      if (metadata.entryPoint) {
        urls.set(
          path.basename(metadata.entryPoint).replace(/\.ts$/, ".js"),
          `/assets/${path.basename(output)}`,
        );
      }
    }
  }
  for (const filename of stylesheets) {
    const { code } = transform({
      filename,
      code: await readFile(path.join(sourceDirectory, filename)),
      minify: true,
      targets: cssTargets,
    });
    const digest = createHash("sha256").update(code).digest("hex").slice(0, 16);
    const output = `${path.basename(filename, ".css")}-${digest}.css`;
    await writeFile(path.join(outputDirectory, output), code);
    urls.set(filename, `/assets/${output}`);
  }
  for (const [filename, template] of templates) {
    const optimized = template
      .replace(
        /\b(src|href)="\/(\w[\w-]*\.(?:js|css))(?:\?[^"<>]*)?"/g,
        (attribute, name, source) =>
          urls.has(source) ? `${name}="${urls.get(source)}"` : attribute,
      )
      .replace(/<style>([\s\S]*?)<\/style>/g, (_, css) => {
        const { code } = transform({
          filename,
          code: Buffer.from(css),
          minify: true,
          targets: cssTargets,
        });
        return `<style>${code.toString()}</style>`;
      });
    await writeFile(path.join(templateDirectory, filename), optimized);
  }
  const assets = await readdir(outputDirectory);
  let originalBytes = 0;
  let compressedBytes = 0;
  for (const filename of assets) {
    const code = await readFile(path.join(outputDirectory, filename));
    const compressed = brotliCompressSync(code);
    await writeFile(path.join(outputDirectory, `${filename}.br`), compressed);
    await writeFile(
      path.join(outputDirectory, `${filename}.gz`),
      gzipSync(code, { level: 9 }),
    );
    originalBytes += code.length;
    compressedBytes += compressed.length;
  }
  await writeFile(
    path.join(templateDirectory, "assets.json"),
    JSON.stringify(assets),
  );
  console.log(
    `Client assets: ${originalBytes} bytes minified, ${compressedBytes} bytes Brotli (${assets.length} files).`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  await buildClient();
}
