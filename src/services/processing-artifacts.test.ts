import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  atomicJson,
  readManifest,
  chunkCheckpoint,
  type ChunkManifest,
} from "./processing-artifacts.js";

let directory: string;
const manifest: ChunkManifest = {
  version: 1,
  chunkSeconds: 300,
  model: "gpt-4o-transcribe-diarize",
  language: "en",
  files: ["chunk-000.mp3", "chunk-001.mp3"],
};
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "p2a-artifacts-"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

it("ignores partial writes and recovers published chunks without a job completion marker", async () => {
  const checkpoint = chunkCheckpoint(directory, manifest);
  await writeFile(path.join(directory, "transcript-0.json.tmp"), '{"text":');
  expect(await checkpoint.load(0)).toBeUndefined();

  await checkpoint.save(0, { text: "Saved before interruption" });
  const recovered = chunkCheckpoint(directory, manifest);

  expect(await recovered.load(0)).toEqual({
    text: "Saved before interruption",
  });
  expect(await recovered.load(1)).toBeUndefined();
  await expect(
    readFile(path.join(directory, "transcript-0.json.tmp")),
  ).rejects.toMatchObject({ code: "ENOENT" });
});

it("preserves valid silent chunks and refuses corrupt final results", async () => {
  const checkpoint = chunkCheckpoint(directory, manifest);
  await checkpoint.save(0, { text: "", segments: [] });
  await writeFile(path.join(directory, "transcript-1.json"), '{"text":');

  expect(await checkpoint.load(0)).toEqual({ text: "", segments: [] });
  await expect(checkpoint.load(1)).rejects.toThrow();
});

it("keeps saved settings and rejects a manifest that escapes the workspace", async () => {
  await atomicJson(path.join(directory, "chunks.json"), manifest);
  expect(await readManifest(directory)).toEqual(manifest);

  await atomicJson(path.join(directory, "chunks.json"), {
    ...manifest,
    files: ["../other/chunk-000.mp3"],
  });

  await expect(readManifest(directory)).rejects.toThrow();
});
