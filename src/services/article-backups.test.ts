import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { S3Client } from "@aws-sdk/client-s3";
import {
  ArticleBackupWorker,
  backupConfiguration,
  backupKey,
  createArticleBackup,
  restoreArticleBackup,
  s3BackupUploader,
} from "./article-backups.js";
import { generateArticlePdf } from "./pdf.js";
import type { Job } from "../types.js";

const config = {
  bucket: "private-backups",
  region: "eu-west-1",
  prefix: "articles",
};
const job: Job = {
  id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  sourceUrl: "https://www.youtube.com/watch?v=example",
  language: "nl",
  articleLength: "standard",
  stage: "complete",
  progress: 100,
  message: "Processing log",
  createdAt: "2026-09-19T10:00:00Z",
  updatedAt: "2026-09-19T11:00:00Z",
  completedAt: "2026-09-19T11:00:00Z",
  shareToken: "secret",
  shareAnalytics: { loads: 2, reads: 1, recentVisits: [] },
  readAt: "2026-09-19T12:00:00Z",
  episode: {
    sourceType: "youtube",
    sourceName: "Example channel",
    title: "Example episode",
    sourceUrl: "https://youtube.com/watch?v=example",
    mediaUrl: "https://private.example/media",
    description: "Excluded description",
  },
  transcript: [
    {
      id: "t-1",
      start: 0,
      end: 10,
      speaker: "Speaker",
      text: "Private transcript",
    },
  ],
  article: {
    title: "Final article",
    dek: "Summary",
    readingTimeMinutes: 3,
    styleNote: "Editorial",
    sections: [
      {
        heading: "Topic",
        paragraphs: [{ text: "Final text", sources: ["t-1"] }],
      },
    ],
    takeaways: [],
  },
};
let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "article-backup-"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});
async function store(owner: string, value = job): Promise<void> {
  const directory = path.join(root, "users", owner, "jobs");
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, `${value.id}.json`),
    JSON.stringify(value),
  );
}

describe("article backup format", () => {
  it("includes only final content and explicit identifying metadata, stripping nested unknown fields", () => {
    const payload = createArticleBackup("owner", {
      ...job,
      prompts: "private prompt",
      modelResponses: "raw response",
      article: { ...job.article, transcript: "private transcript" },
    });

    expect(payload).toEqual({
      schemaVersion: 1,
      owner: "owner",
      jobId: job.id,
      language: "nl",
      articleLength: "standard",
      createdAt: job.createdAt,
      completedAt: job.completedAt,
      source: {
        sourceUrl: job.sourceUrl,
        sourceType: "youtube",
        sourceName: "Example channel",
        title: "Example episode",
      },
      article: job.article,
    });
  });

  it.each([
    "queued",
    "resolving",
    "downloading",
    "transcribing",
    "writing",
    "failed",
  ])("excludes %s jobs even with stale article content", (stage) => {
    expect(createArticleBackup("owner", { ...job, stage })).toBeUndefined();
  });

  it("validates identities and normalizes legacy completion timestamps", () => {
    expect(() => createArticleBackup("../other", job)).toThrow();
    expect(() => backupKey(config, "owner", "../other")).toThrow();
    expect(
      createArticleBackup("owner", { ...job, completedAt: undefined })
        ?.completedAt,
    ).toBe(job.updatedAt);
    expect(backupConfiguration({})).toBeUndefined();
    expect(() =>
      backupConfiguration({ ARTICLE_BACKUP_BUCKET: "bucket" }),
    ).toThrow();
    expect(() =>
      backupConfiguration({
        ARTICLE_BACKUP_BUCKET: "bucket",
        ARTICLE_BACKUP_REGION: "eu-west-1",
        ARTICLE_BACKUP_PREFIX: "../escape",
      }),
    ).toThrow();
  });
});

describe("durable article backup worker", () => {
  it("isolates identical job IDs by owner and avoids repeated uploads across restarts", async () => {
    await store("owner");
    await store("other");
    const upload = vi.fn().mockResolvedValue(undefined);

    expect(await new ArticleBackupWorker(root, config, upload).flush()).toBe(0);
    expect(await new ArticleBackupWorker(root, config, upload).flush()).toBe(0);

    expect(upload).toHaveBeenCalledTimes(2);
    expect(upload.mock.calls.map(([key]) => key).sort()).toEqual([
      backupKey(config, "other", job.id),
      backupKey(config, "owner", job.id),
    ]);
  });

  it("recovers failed uploads after restart without changing a completed job or blocking another owner", async () => {
    await store("owner");
    await store("other");
    const upload = vi
      .fn()
      .mockRejectedValueOnce(new Error("S3 unavailable"))
      .mockResolvedValue(undefined);
    const logging = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(await new ArticleBackupWorker(root, config, upload).flush()).toBe(1);
    expect(await new ArticleBackupWorker(root, config, upload).flush()).toBe(0);

    expect(upload).toHaveBeenCalledTimes(3);
    expect(logging).toHaveBeenCalledWith(
      expect.stringContaining("retained locally for retry"),
    );
    expect(
      JSON.parse(
        await readFile(
          path.join(root, "users/owner/jobs", `${job.id}.json`),
          "utf8",
        ),
      ),
    ).toEqual(job);
  });

  it("uploads changed final content to the same key and reuploads when the destination changes", async () => {
    await store("owner");
    const upload = vi.fn().mockResolvedValue(undefined);
    const worker = new ArticleBackupWorker(root, config, upload);
    await worker.flush();
    if (!job.article) {
      throw new Error("Fixture requires an article");
    }
    await store("owner", {
      ...job,
      article: { ...job.article, title: "Revised" },
    });

    await worker.flush();
    await new ArticleBackupWorker(
      root,
      { ...config, bucket: "replacement" },
      upload,
    ).flush();

    expect(upload).toHaveBeenCalledTimes(3);
    expect(upload.mock.calls[0]?.[0]).toBe(upload.mock.calls[1]?.[0]);
    expect(JSON.parse(upload.mock.calls[1]?.[1]).article.title).toBe("Revised");
  });

  it("skips incomplete jobs, retains soft-deleted backups and ignores owner read-state changes", async () => {
    await store("owner", { ...job, stage: "failed" });
    const upload = vi.fn().mockResolvedValue(undefined);
    const worker = new ArticleBackupWorker(root, config, upload);
    await worker.flush();
    expect(upload).not.toHaveBeenCalled();
    await store("owner", { ...job, deletedAt: job.updatedAt });
    await worker.flush();
    await store("owner", {
      ...job,
      readAt: undefined,
      updatedAt: "2026-09-20T12:00:00Z",
    });
    await worker.flush();

    expect(upload).toHaveBeenCalledTimes(1);
  });

  it("retries on the next scan after a corrupt local file and rejects identity mismatches", async () => {
    await store("owner");
    const file = path.join(root, "users/owner/jobs", `${job.id}.json`);
    await writeFile(file, "{");
    const upload = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const worker = new ArticleBackupWorker(root, config, upload);
    expect(await worker.flush()).toBe(1);
    await writeFile(
      file,
      JSON.stringify({ ...job, id: "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee" }),
    );
    expect(await worker.flush()).toBe(1);
    expect(upload).not.toHaveBeenCalled();
    await store("owner");
    expect(await worker.flush()).toBe(0);
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it("sends encrypted JSON with no public ACL", async () => {
    const send = vi
      .spyOn(S3Client.prototype, "send")
      .mockResolvedValue({} as never);

    await s3BackupUploader(config)("key", "{}");

    expect(send.mock.calls[0]?.[0].input).toEqual({
      Bucket: config.bucket,
      Key: "key",
      Body: "{}",
      ContentType: "application/json",
      ServerSideEncryption: "AES256",
    });
  });
});

describe("article restoration", () => {
  it("restores a readable completed article without generation artifacts and refuses overwrites", async () => {
    const payload = createArticleBackup("owner", job);

    const destination = await restoreArticleBackup(
      root,
      payload,
      "owner",
      job.id,
    );
    const restored: Job = JSON.parse(await readFile(destination, "utf8"));

    expect(restored).toMatchObject({
      id: job.id,
      stage: "complete",
      article: job.article,
      episode: { mediaUrl: "" },
    });
    expect(restored.transcript).toEqual([]);
    const pdf = await generateArticlePdf(
      restored,
      "http://127.0.0.1:4317",
      "en",
    );
    expect(Buffer.from(pdf).subarray(0, 4).toString()).toBe("%PDF");
    expect(restored.shareToken).toBeUndefined();
    await expect(
      restoreArticleBackup(root, payload, "owner", job.id),
    ).rejects.toMatchObject({ code: "EEXIST" });
    await expect(
      restoreArticleBackup(root, payload, "other", job.id),
    ).rejects.toThrow("does not match");
    await expect(
      restoreArticleBackup(
        root,
        { ...payload, schemaVersion: 2 },
        "owner",
        job.id,
      ),
    ).rejects.toThrow();
  });
});
