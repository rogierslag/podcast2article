import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { clientAssets } from "./client-assets.js";

test("client catalogs expose only manifest-listed asset names and keep templates separate", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "p2a-asset-catalog-"));
  try {
    await mkdir(path.join(directory, "client-templates"));
    await writeFile(
      path.join(directory, "client-templates/assets.json"),
      JSON.stringify(["reader-123456.js", "reader-123456.css"]),
    );

    const client = await clientAssets(directory, "public");

    expect(client.assetDirectory).toBe(path.join(directory, "client"));
    expect(client.templateDirectory).toBe(
      path.join(directory, "client-templates"),
    );
    expect([...client.filenames]).toEqual([
      "reader-123456.js",
      "reader-123456.css",
    ]);
    expect(client.filenames.has("../server.js")).toBe(false);
    expect(client.filenames.has("assets.json")).toBe(false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("development falls back to source templates while corrupt build manifests fail visibly", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "p2a-asset-manifest-"));
  try {
    expect((await clientAssets(directory, "public")).templateDirectory).toBe(
      "public",
    );

    await mkdir(path.join(directory, "client-templates"));
    await writeFile(
      path.join(directory, "client-templates/assets.json"),
      JSON.stringify(["../server.js"]),
    );

    await expect(clientAssets(directory, "public")).rejects.toThrow(
      "Invalid client asset manifest",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
