import { createHash, randomUUID } from "node:crypto";
import {
  link,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { gzip, gunzip } from "node:zlib";
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { z } from "zod";
import type { Job } from "../types.js";
import { hasArticleContent } from "../lib/job-content.js";
import {
  isMissingFile,
  jobIdSchema,
  parseStoredJob,
  readStoredJob,
  serializeStoredJob,
  StoredJobError,
  usernameSchema,
} from "./stored-jobs.js";

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);
const BACKUP_RETRY_DELAY_MS = 15 * 60_000;

const timestamp = z
  .string()
  .refine((value) => Number.isFinite(Date.parse(value)));
const paragraphSchema = z.object({
  kind: z.enum(["paragraph", "quote"]).optional(),
  text: z.string(),
  sources: z.array(z.string()),
});
// Object schemas strip unknown fields at every level.
// Never serialize a stored Job.
export const articleBackupSchema = z.object({
  schemaVersion: z.literal(1),
  owner: usernameSchema,
  jobId: jobIdSchema,
  language: z.string(),
  articleLength: z.enum(["compact", "standard", "long"]),
  createdAt: timestamp,
  completedAt: timestamp,
  source: z.object({
    sourceUrl: z.string(),
    sourceType: z.enum(["spotify", "rss", "google-drive", "youtube", "fathom"]),
    sourceName: z.string(),
    title: z.string(),
    imageUrl: z.string().optional(),
    publishedAt: z.string().optional(),
  }),
  article: z.object({
    title: z.string(),
    dek: z.string(),
    readingTimeMinutes: z.number().nonnegative(),
    styleNote: z.string(),
    sections: z.array(
      z.object({ heading: z.string(), paragraphs: z.array(paragraphSchema) }),
    ),
    takeaways: z.array(paragraphSchema),
  }),
});
export type ArticleBackup = z.infer<typeof articleBackupSchema>;

export function createArticleBackup(
  owner: string,
  input: unknown,
): ArticleBackup | undefined {
  const { id } = z.object({ id: jobIdSchema }).parse(input);
  return backupFromJob(
    usernameSchema.parse(owner),
    parseStoredJob(input, owner, id),
  );
}

function backupFromJob(owner: string, job: Job): ArticleBackup | undefined {
  if (job.stage !== "complete" || !hasArticleContent(job)) {
    return undefined;
  }
  return articleBackupSchema.parse({
    schemaVersion: 1,
    owner,
    jobId: job.id,
    language: job.language,
    articleLength: job.articleLength,
    createdAt: job.createdAt,
    completedAt: job.completedAt,
    source: { ...job.episode, sourceUrl: job.sourceUrl },
    article: job.article,
  });
}

export interface BackupConfiguration {
  bucket: string;
  region: string;
  prefix: string;
}
export function backupConfiguration(
  env = process.env,
): BackupConfiguration | undefined {
  if (!env.ARTICLE_BACKUP_BUCKET) {
    return undefined;
  }
  const region = env.ARTICLE_BACKUP_REGION;
  if (!region) {
    throw new Error(
      "ARTICLE_BACKUP_REGION is required when article backups are enabled",
    );
  }
  const prefix = (env.ARTICLE_BACKUP_PREFIX ?? "articles").replace(
    /^\/+|\/+$/g,
    "",
  );
  if (
    prefix &&
    !prefix.split("/").every((part) => /^[a-zA-Z0-9_-]+$/.test(part))
  ) {
    throw new Error(
      "ARTICLE_BACKUP_PREFIX must contain slash-separated letters, digits, underscores or hyphens",
    );
  }
  return { bucket: env.ARTICLE_BACKUP_BUCKET, region, prefix };
}

export function backupKey(
  config: BackupConfiguration,
  owner: string,
  id: string,
): string {
  usernameSchema.parse(owner);
  jobIdSchema.parse(id);
  return [config.prefix, "v1", "users", owner, `${id}.json.gz`]
    .filter(Boolean)
    .join("/");
}

export function s3BackupUploader(
  config: BackupConfiguration,
): (key: string, body: string) => Promise<void> {
  const client = new S3Client({ region: config.region, maxAttempts: 1 });
  return async (key, body) => {
    const compressed = await gzipAsync(body);
    await client.send(
      new PutObjectCommand({
        Bucket: config.bucket,
        Key: key,
        Body: compressed,
        ChecksumSHA256: createHash("sha256")
          .update(compressed)
          .digest("base64"),
        ContentType: "application/json",
        ContentEncoding: "gzip",
        ServerSideEncryption: "AES256",
      }),
      { abortSignal: AbortSignal.timeout(30_000) },
    );
  };
}

export async function fetchArticleBackup(
  client: S3Client,
  config: BackupConfiguration,
  owner: string,
  id: string,
): Promise<unknown> {
  const key = backupKey(config, owner, id);
  const getObject = async (objectKey: string) =>
    client.send(
      new GetObjectCommand({
        Bucket: config.bucket,
        Key: objectKey,
        ChecksumMode: "ENABLED",
      }),
      { abortSignal: AbortSignal.timeout(30_000) },
    );
  const response = await getObject(key).catch((error: unknown) => {
    // Only a missing gzip key permits falling back to a potentially older legacy object.
    if (error instanceof Error && error.name === "NoSuchKey") {
      return getObject(key.slice(0, -3));
    }
    throw error;
  });
  if (!response.Body) {
    throw new Error("Empty backup response");
  }
  return decodeArticleBackup(
    await response.Body.transformToByteArray(),
    response.ContentEncoding,
    response.ChecksumSHA256,
  );
}

export async function decodeArticleBackup(
  body: Uint8Array,
  contentEncoding?: string,
  checksumSHA256?: string,
): Promise<unknown> {
  if (
    checksumSHA256 &&
    createHash("sha256").update(body).digest("base64") !== checksumSHA256
  ) {
    throw new Error("Article backup checksum mismatch");
  }
  const compressed =
    contentEncoding?.toLowerCase() === "gzip" ||
    (body[0] === 0x1f && body[1] === 0x8b);
  const decoded = compressed ? await gunzipAsync(body) : Buffer.from(body);
  return JSON.parse(decoded.toString("utf8"));
}

function failure(context: string, error: unknown): void {
  // SDK errors can include request details; log only the error class, never credentials or article content.
  console.error(
    `${new Date().toISOString()} ERROR Article backup ${context}: ${error instanceof Error ? error.name : "UnknownError"}`,
  );
}

export class ArticleBackupWorker {
  private running?: Promise<number>;
  private timer?: NodeJS.Timeout;
  private requested = false;
  private stopped = false;
  private retryAfter = 0;
  constructor(
    private readonly root: string,
    private readonly config: BackupConfiguration,
    private readonly upload = s3BackupUploader(config),
  ) {}

  start(): void {
    this.request();
    this.timer = setInterval(() => this.request(), 60_000);
    this.timer.unref();
  }

  request(): void {
    if (this.stopped) {
      return;
    }
    this.requested = true;
    if (!this.running) {
      void this.flush().catch((error: unknown) =>
        failure("scan failed; retry in 15 minutes", error),
      );
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    await this.running;
  }

  async flush(): Promise<number> {
    if (this.running) {
      return this.running;
    }
    if (Date.now() < this.retryAfter) {
      return 1;
    }
    this.requested = false;
    this.running = this.scan();
    try {
      return await this.running;
    } catch (error) {
      this.retryAfter = Date.now() + BACKUP_RETRY_DELAY_MS;
      throw error;
    } finally {
      this.running = undefined;
      if (this.requested && !this.stopped) {
        this.request();
      }
    }
  }

  private async scan(): Promise<number> {
    let failures = 0;
    const usersRoot = path.join(this.root, "users");
    const users = await readdir(usersRoot, { withFileTypes: true }).catch(
      (error: unknown) => {
        if (isMissingFile(error)) {
          return [];
        }
        throw error;
      },
    );
    for (const user of users) {
      if (!user.isDirectory() || !usernameSchema.safeParse(user.name).success) {
        continue;
      }
      const directory = path.join(usersRoot, user.name, "jobs");
      let files: string[];
      try {
        files = await readdir(directory);
      } catch (error) {
        if (!isMissingFile(error)) {
          failures++;
          failure(
            `${user.name}/jobs could not be listed`,
            "filesystem read failed",
          );
        }
        continue;
      }
      for (const file of files) {
        if (this.stopped) {
          return failures;
        }
        if (
          !file.endsWith(".json") ||
          !jobIdSchema.safeParse(file.slice(0, -5)).success
        ) {
          continue;
        }
        try {
          const job = await readStoredJob(
            directory,
            user.name,
            file.slice(0, -5),
          );
          const payload = job && backupFromJob(user.name, job);
          if (!payload) {
            continue;
          }
          const key = backupKey(this.config, user.name, payload.jobId);
          const body = JSON.stringify(payload);
          const digest = createHash("sha256")
            .update(JSON.stringify(this.config))
            .update(key)
            .update(body)
            .digest("hex");
          const receiptDirectory = path.join(
            this.root,
            "article-backups",
            user.name,
          );
          const receipt = path.join(
            receiptDirectory,
            `${payload.jobId}.sha256`,
          );
          const previous = await readFile(receipt, "utf8").catch(
            (error: unknown) => {
              if (isMissingFile(error)) {
                return undefined;
              }
              throw error;
            },
          );
          if (previous === digest) {
            continue;
          }
          try {
            await this.upload(key, body);
            await mkdir(receiptDirectory, { recursive: true, mode: 0o700 });
            const temporary = `${receipt}.tmp`;
            await writeFile(temporary, digest, { mode: 0o600 });
            await rename(temporary, receipt);
          } catch (error) {
            this.retryAfter = Date.now() + BACKUP_RETRY_DELAY_MS;
            failure(
              `${user.name}/${file} upload or receipt failed; retained locally for retry in 15 minutes`,
              error,
            );
            return failures + 1;
          }
          console.log(
            `${new Date().toISOString()} INFO Article backup uploaded: ${user.name}/${payload.jobId}`,
          );
        } catch (error) {
          failures++;
          failure(
            `${user.name}/${file} failed; retained locally for retry`,
            error instanceof StoredJobError ? error.reason : error,
          );
        }
      }
    }
    return failures;
  }
}

export async function restoreArticleBackup(
  root: string,
  input: unknown,
  owner: string,
  id: string,
): Promise<string> {
  const backup = articleBackupSchema.parse(input);
  if (
    backup.owner !== usernameSchema.parse(owner) ||
    backup.jobId !== jobIdSchema.parse(id)
  ) {
    throw new Error(
      "Backup owner or job ID does not match the requested destination",
    );
  }
  const job: Job = {
    id: backup.jobId,
    sourceUrl: backup.source.sourceUrl,
    language: backup.language,
    articleLength: backup.articleLength,
    createdAt: backup.createdAt,
    updatedAt: backup.completedAt,
    completedAt: backup.completedAt,
    stage: "complete",
    progress: 100,
    message: "Restored from article backup",
    // The reader and PDF exporter require a transcript collection, even when empty.
    transcript: [],
    episode: { ...backup.source, mediaUrl: "" },
    article: backup.article,
  };
  const directory = path.join(root, "users", backup.owner, "jobs");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const destination = path.join(directory, `${backup.jobId}.json`);
  const temporary = path.join(directory, `${randomUUID()}.restore-tmp`);
  try {
    await writeFile(temporary, serializeStoredJob(owner, job), {
      flag: "wx",
      mode: 0o600,
    });
    // Publish atomically without ever overwriting an existing job.
    await link(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
  return destination;
}

let worker: ArticleBackupWorker | undefined;
export function startArticleBackups(): void {
  const config = backupConfiguration();
  if (!config) {
    console.log(
      "Article backups disabled: ARTICLE_BACKUP_BUCKET is not configured",
    );
    return;
  }
  worker = new ArticleBackupWorker(path.resolve("data"), config);
  worker.start();
}
export function requestArticleBackup(): void {
  worker?.request();
}
export async function stopArticleBackups(): Promise<void> {
  await worker?.stop();
}
