import type * as FsPromises from "node:fs/promises";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Job } from "../types.js";
import { readStoredJob, serializeStoredJob } from "./stored-jobs.js";

const storage = vi.hoisted(() => ({ denied: "" }));
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof FsPromises>();
  return {
    ...fs,
    readFile: async (file: string, encoding: BufferEncoding) => {
      if (file === storage.denied) {
        throw Object.assign(new Error(`Permission denied: ${file}`), {
          code: "EACCES",
        });
      }
      return fs.readFile(file, encoding);
    },
  };
});

const job = {
  id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  stage: "queued",
  progress: 2,
  message: "job.queued",
  sourceUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  language: "en",
  articleLength: "standard",
  createdAt: "2026-09-01T10:00:00Z",
  updatedAt: "2026-09-01T10:00:00Z",
} satisfies Job;

let directory: string;
let file: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "stored-job-"));
  file = path.join(directory, `${job.id}.json`);
});
afterEach(async () => {
  storage.denied = "";
  await rm(directory, { recursive: true, force: true });
});

it.each([
  ["malformed JSON", "{"],
  ["unsupported schema version", { ...job, schemaVersion: 7 }],
  [
    "owner or job ID does not match the path",
    { ...job, id: "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee" },
  ],
  [
    "owner or job ID does not match the path",
    { ...job, owner: "other", schemaVersion: 1 },
  ],
  ["missing required stage data", { ...job, stage: "writing" }],
  ["missing required stage data", { ...job, stage: "complete" }],
  ["invalid job fields", { ...job, sourceUrl: "file:///tmp/input" }],
  ["invalid job fields", { ...job, articleRetryAttempts: -1 }],
  [
    "invalid job fields",
    { ...job, transcript: [{ id: "t-1", start: "private value" }] },
  ],
  [
    "invalid job fields",
    { ...job, article: { title: "An article", sections: [null] } },
  ],
  [
    "invalid job fields",
    { ...job, backgroundArticle: { responseId: "resp_1", request: {} } },
  ],
  [
    "invalid job fields",
    { ...job, readingPosition: { sectionIndex: "private value" } },
  ],
  [
    "invalid job fields",
    { ...job, apiUsage: { coverage: "complete", requests: [null] } },
  ],
])("rejects %s", async (reason, input) => {
  await writeFile(
    file,
    typeof input === "string" ? input : JSON.stringify(input),
  );

  await expect(readStoredJob(directory, "owner", job.id)).rejects.toMatchObject(
    {
      code: "error.jobRecordInvalid",
      reason,
    },
  );
});

it("distinguishes a missing file from a denied read", async () => {
  await expect(
    readStoredJob(directory, "owner", job.id),
  ).resolves.toBeUndefined();

  await writeFile(file, serializeStoredJob("owner", job));
  storage.denied = file;

  await expect(readStoredJob(directory, "owner", job.id)).rejects.toMatchObject(
    {
      code: "error.jobStorageUnavailable",
      reason: "filesystem read failed",
    },
  );
});
