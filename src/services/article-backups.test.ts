import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { S3Client } from "@aws-sdk/client-s3";
import {
  ArticleBackupWorker,
  backupConfiguration,
  backupKey,
  createArticleBackup,
  decodeArticleBackup,
  fetchArticleBackup,
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
  vi.useRealTimers();
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

  it("uses an explicit gzip extension for new backup keys", () => {
    expect(backupKey(config, "owner", job.id)).toBe(
      `articles/v1/users/owner/${job.id}.json.gz`,
    );
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

  it("recovers failed uploads after restart without changing a completed job", async () => {
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

  it("pauses all uploads for 15 minutes after each failure, including completion requests", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    await store("owner");
    await store("other");
    const upload = vi.fn().mockRejectedValue(new Error("S3 unavailable"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const worker = new ArticleBackupWorker(root, config, upload);
    worker.start();
    await worker.flush();

    for (let minute = 0; minute < 14; minute++) {
      await vi.advanceTimersByTimeAsync(60_000);
      worker.request();
      expect(await worker.flush()).toBe(1);
    }
    await vi.advanceTimersByTimeAsync(59_999);
    expect(await worker.flush()).toBe(1);
    expect(upload).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(await worker.flush()).toBe(1);
    expect(upload).toHaveBeenCalledTimes(2);
    upload.mockResolvedValue(undefined);
    worker.request();
    expect(await worker.flush()).toBe(1);
    expect(upload).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(await worker.flush()).toBe(0);
    expect(upload).toHaveBeenCalledTimes(4);
    await worker.stop();
  });

  it("backs off when an uploaded object's local receipt cannot be saved", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    await store("owner");
    const temporary = path.join(
      root,
      "article-backups",
      "owner",
      `${job.id}.sha256.tmp`,
    );
    await mkdir(temporary, { recursive: true });
    const upload = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const worker = new ArticleBackupWorker(root, config, upload);

    expect(await worker.flush()).toBe(1);
    await rm(temporary, { recursive: true });
    expect(await worker.flush()).toBe(1);
    expect(upload).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 15 * 60_000);
    expect(await worker.flush()).toBe(0);
    expect(upload).toHaveBeenCalledTimes(2);
  });

  it("serializes overlapping scans and follows a completion received during an upload", async () => {
    await store("owner");
    if (!job.article) {
      throw new Error("Fixture requires an article");
    }
    const revised = {
      ...job,
      article: { ...job.article, title: "Revised during upload" },
    };
    let activeUploads = 0;
    let maximumActiveUploads = 0;
    const upload = vi.fn(async () => {
      activeUploads++;
      maximumActiveUploads = Math.max(maximumActiveUploads, activeUploads);
      if (upload.mock.calls.length === 1) {
        await store("owner", revised);
        worker.request();
      }
      activeUploads--;
    });
    const worker = new ArticleBackupWorker(root, config, upload);

    await Promise.all([worker.flush(), worker.flush()]);
    await worker.flush();
    await worker.stop();

    expect(maximumActiveUploads).toBe(1);
    expect(upload).toHaveBeenCalledTimes(2);
    const receipt = await readFile(
      path.join(root, "article-backups", "owner", `${job.id}.sha256`),
      "utf8",
    );
    const expected = createHash("sha256")
      .update(JSON.stringify(config))
      .update(backupKey(config, "owner", job.id))
      .update(JSON.stringify(createArticleBackup("owner", revised)))
      .digest("hex");
    expect(receipt).toBe(expected);
    expect(await new ArticleBackupWorker(root, config, upload).flush()).toBe(0);
    expect(upload).toHaveBeenCalledTimes(2);
  });

  it("keeps an uncertain upload pending and retries the latest local article after cooldown", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    await store("owner");
    const upload = vi
      .fn<(key: string, body: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error("Connection lost after PUT"))
      .mockResolvedValue(undefined);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const worker = new ArticleBackupWorker(root, config, upload);

    expect(await worker.flush()).toBe(1);
    await expect(
      readFile(path.join(root, "article-backups", "owner", `${job.id}.sha256`)),
    ).rejects.toMatchObject({ code: "ENOENT" });
    if (!job.article) {
      throw new Error("Fixture requires an article");
    }
    await store("owner", {
      ...job,
      article: { ...job.article, title: "Latest revision" },
    });
    vi.setSystemTime(Date.now() + 15 * 60_000);
    expect(await worker.flush()).toBe(0);

    expect(upload).toHaveBeenCalledTimes(2);
    expect(JSON.parse(upload.mock.calls[1]?.[1] ?? "{}").article.title).toBe(
      "Latest revision",
    );
  });

  it("uploads once to the gzip key when a legacy JSON receipt exists", async () => {
    await store("owner");
    const receiptDirectory = path.join(root, "article-backups", "owner");
    await mkdir(receiptDirectory, { recursive: true });
    const legacyDigest = createHash("sha256")
      .update(JSON.stringify(config))
      .update(`articles/v1/users/owner/${job.id}.json`)
      .update(JSON.stringify(createArticleBackup("owner", job)))
      .digest("hex");
    await writeFile(
      path.join(receiptDirectory, `${job.id}.sha256`),
      legacyDigest,
    );
    const upload = vi.fn().mockResolvedValue(undefined);

    await new ArticleBackupWorker(root, config, upload).flush();
    await new ArticleBackupWorker(root, config, upload).flush();

    expect(upload).toHaveBeenCalledTimes(1);
    expect(upload.mock.calls[0]?.[0]).toBe(
      `articles/v1/users/owner/${job.id}.json.gz`,
    );
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

  it("sends gzip-compressed encrypted JSON with no public ACL", async () => {
    const send = vi
      .spyOn(S3Client.prototype, "send")
      .mockResolvedValue({} as never);

    await s3BackupUploader(config)("key", "{}");

    const input = send.mock.calls[0]?.[0].input;
    expect(input).toEqual({
      Bucket: config.bucket,
      Key: "key",
      Body: expect.any(Buffer),
      ChecksumSHA256: expect.any(String),
      ContentType: "application/json",
      ContentEncoding: "gzip",
      ServerSideEncryption: "AES256",
    });
    if (!input || !("Body" in input) || !Buffer.isBuffer(input.Body)) {
      throw new Error("Expected compressed upload body");
    }
    expect(input.ChecksumSHA256).toBe(
      createHash("sha256").update(input.Body).digest("base64"),
    );
    expect(
      await decodeArticleBackup(input.Body, "gzip", input.ChecksumSHA256),
    ).toEqual({});
  });
});

describe("article restoration", () => {
  it("fetches the gzip key with checksum verification", async () => {
    const body = gzipSync(JSON.stringify(createArticleBackup("owner", job)));
    // The SDK send overload needs a mock result containing only the response fields consumed here.
    const send = vi.spyOn(S3Client.prototype, "send").mockResolvedValue({
      Body: { transformToByteArray: async () => body },
      ContentEncoding: "gzip",
      ChecksumSHA256: createHash("sha256").update(body).digest("base64"),
    } as never);
    const client = new S3Client({ region: config.region });
    try {
      expect(await fetchArticleBackup(client, config, "owner", job.id)).toEqual(
        createArticleBackup("owner", job),
      );
      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0]?.[0].input).toEqual({
        Bucket: config.bucket,
        Key: backupKey(config, "owner", job.id),
        ChecksumMode: "ENABLED",
      });
    } finally {
      client.destroy();
    }
  });

  it("falls back to the legacy JSON key only when the gzip key does not exist", async () => {
    const body = Buffer.from(JSON.stringify(createArticleBackup("owner", job)));
    const send = vi
      .spyOn(S3Client.prototype, "send")
      .mockRejectedValueOnce(
        Object.assign(new Error("Missing"), { name: "NoSuchKey" }),
      )
      .mockResolvedValue({
        Body: { transformToByteArray: async () => body },
      } as never);
    const client = new S3Client({ region: config.region });
    try {
      expect(await fetchArticleBackup(client, config, "owner", job.id)).toEqual(
        createArticleBackup("owner", job),
      );
      expect(send).toHaveBeenCalledTimes(2);
      expect(send.mock.calls[1]?.[0].input).toMatchObject({
        Key: `articles/v1/users/owner/${job.id}.json`,
      });
    } finally {
      client.destroy();
    }
  });

  it.each(["AccessDenied", "NoSuchBucket", "TimeoutError"])(
    "does not hide %s behind a legacy restore",
    async (name) => {
      const error = Object.assign(new Error(name), { name });
      const send = vi
        .spyOn(S3Client.prototype, "send")
        .mockRejectedValue(error);
      const client = new S3Client({ region: config.region });
      try {
        await expect(
          fetchArticleBackup(client, config, "owner", job.id),
        ).rejects.toBe(error);
        expect(send).toHaveBeenCalledTimes(1);
      } finally {
        client.destroy();
      }
    },
  );

  it("does not restore a stale legacy copy when the gzip object is corrupt", async () => {
    const send = vi.spyOn(S3Client.prototype, "send").mockResolvedValue({
      Body: { transformToByteArray: async () => Buffer.from("corrupt") },
      ContentEncoding: "gzip",
    } as never);
    const client = new S3Client({ region: config.region });
    try {
      await expect(
        fetchArticleBackup(client, config, "owner", job.id),
      ).rejects.toThrow();
      expect(send).toHaveBeenCalledTimes(1);
    } finally {
      client.destroy();
    }
  });

  it("decodes both legacy JSON and gzip objects, including downloaded gzip files", async () => {
    const payload = createArticleBackup("owner", job);
    const body = JSON.stringify(payload);

    expect(await decodeArticleBackup(Buffer.from(body))).toEqual(payload);
    expect(await decodeArticleBackup(gzipSync(body), "gzip")).toEqual(payload);
    expect(await decodeArticleBackup(gzipSync(body))).toEqual(payload);
    await expect(
      decodeArticleBackup(Buffer.from(body), "gzip"),
    ).rejects.toThrow();
  });

  it("checks stored bytes before decoding and rejects corruption even if JSON remains valid", async () => {
    const body = Buffer.from(JSON.stringify(createArticleBackup("owner", job)));
    const checksum = createHash("sha256").update(body).digest("base64");
    const compressed = gzipSync(body);
    const compressedChecksum = createHash("sha256")
      .update(compressed)
      .digest("base64");

    expect(await decodeArticleBackup(body, undefined, checksum)).toEqual(
      createArticleBackup("owner", job),
    );
    expect(
      await decodeArticleBackup(compressed, "gzip", compressedChecksum),
    ).toEqual(createArticleBackup("owner", job));
    const changed = Buffer.from(
      body.toString().replace("Final article", "Other article"),
    );
    await expect(
      decodeArticleBackup(changed, undefined, checksum),
    ).rejects.toThrow("checksum mismatch");
    await expect(
      decodeArticleBackup(compressed, "gzip", checksum),
    ).rejects.toThrow("checksum mismatch");
    await expect(
      decodeArticleBackup(
        compressed.subarray(0, compressed.length - 3),
        "gzip",
      ),
    ).rejects.toThrow();
  });

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
