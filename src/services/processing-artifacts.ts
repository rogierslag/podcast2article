import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const segment = z.object({
  start: z.number().finite().nonnegative().optional(),
  end: z.number().finite().nonnegative().optional(),
  speaker: z.string().optional(),
  text: z.string().optional(),
});
export const chunkTranscriptSchema = z
  .object({
    segments: z.array(segment).optional(),
    text: z.string().optional(),
  })
  .refine((value) => value.segments !== undefined || value.text !== undefined);
export type ChunkTranscript = z.infer<typeof chunkTranscriptSchema>;

const manifestSchema = z.object({
  version: z.literal(1),
  chunkSeconds: z.number().int().min(60).max(1200),
  model: z.string().min(1),
  language: z.string().min(1),
  files: z.array(z.string().regex(/^chunk-\d+\.mp3$/)).min(1),
});
export type ChunkManifest = z.infer<typeof manifestSchema>;

export async function atomicJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(`${file}.tmp`, JSON.stringify(value));
  await rename(`${file}.tmp`, file);
}

export async function readJson(file: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    // Corrupt final artifacts are reported rather than silently spending again.
    throw error;
  }
}

export async function completeFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).size > 0;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export async function readManifest(
  workspace: string,
): Promise<ChunkManifest | undefined> {
  const value = await readJson(path.join(workspace, "chunks.json"));
  return value === undefined ? undefined : manifestSchema.parse(value);
}

export function chunkCheckpoint(workspace: string, manifest: ChunkManifest) {
  const file = (index: number) =>
    path.join(workspace, `transcript-${index}.json`);
  return {
    chunkSeconds: manifest.chunkSeconds,
    model: manifest.model,
    language: manifest.language,
    async load(index: number): Promise<ChunkTranscript | undefined> {
      const value = await readJson(file(index));
      return value === undefined
        ? undefined
        : chunkTranscriptSchema.parse(value);
    },
    async save(index: number, response: ChunkTranscript): Promise<void> {
      await atomicJson(file(index), chunkTranscriptSchema.parse(response));
    },
  };
}
