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
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { z } from "zod";
import type { Job } from "../types.js";

const usernameSchema = z.string().regex(/^[a-z][a-z0-9_-]{1,31}$/);
const idSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
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
  jobId: idSchema,
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
  const job = z.object({ stage: z.string() }).parse(input);
  if (job.stage !== "complete") {
    return undefined;
  }
  const stored = z
    .object({
      id: idSchema,
      language: z.string(),
      articleLength: z.string(),
      createdAt: timestamp,
      updatedAt: timestamp,
      completedAt: timestamp.optional(),
      sourceUrl: z.string().optional(),
      spotifyUrl: z.string().optional(),
      episode: z.object({
        sourceType: z.string().optional(),
        sourceName: z.string().optional(),
        podcast: z.string().optional(),
        title: z.string(),
        imageUrl: z.string().optional(),
        publishedAt: z.string().optional(),
      }),
      article: z.unknown(),
    })
    .parse(input);
  return articleBackupSchema.parse({
    schemaVersion: 1,
    owner,
    jobId: stored.id,
    language: stored.language,
    articleLength: stored.articleLength,
    createdAt: stored.createdAt,
    completedAt: stored.completedAt ?? stored.updatedAt,
    source: {
      sourceUrl: stored.sourceUrl ?? stored.spotifyUrl,
      sourceType: stored.episode.sourceType ?? "spotify",
      sourceName:
        stored.episode.sourceName ??
        stored.episode.podcast ??
        "Unknown podcast",
      title: stored.episode.title,
      imageUrl: stored.episode.imageUrl,
      publishedAt: stored.episode.publishedAt,
    },
    article: stored.article,
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
  idSchema.parse(id);
  return [config.prefix, "v1", "users", owner, `${id}.json`]
    .filter(Boolean)
    .join("/");
}

export function s3BackupUploader(
  config: BackupConfiguration,
): (key: string, body: string) => Promise<void> {
  const client = new S3Client({ region: config.region, maxAttempts: 3 });
  return async (key, body) => {
    await client.send(
      new PutObjectCommand({
        Bucket: config.bucket,
        Key: key,
        Body: body,
        ContentType: "application/json",
        ServerSideEncryption: "AES256",
      }),
      { abortSignal: AbortSignal.timeout(30_000) },
    );
  };
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
        failure("scan failed; retry in 60 seconds", error),
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
    this.requested = false;
    this.running = this.scan();
    try {
      return await this.running;
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
        if (isMissing(error)) {
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
      const files = await readdir(directory).catch((error: unknown) => {
        if (isMissing(error)) {
          return [];
        }
        throw error;
      });
      for (const file of files) {
        if (this.stopped) {
          return failures;
        }
        if (
          !file.endsWith(".json") ||
          !idSchema.safeParse(file.slice(0, -5)).success
        ) {
          continue;
        }
        try {
          const payload = createArticleBackup(
            user.name,
            JSON.parse(await readFile(path.join(directory, file), "utf8")),
          );
          if (!payload) {
            continue;
          }
          if (`${payload.jobId}.json` !== file) {
            throw new Error("Job identity mismatch");
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
              if (isMissing(error)) {
                return undefined;
              }
              throw error;
            },
          );
          if (previous === digest) {
            continue;
          }
          await this.upload(key, body);
          await mkdir(receiptDirectory, { recursive: true, mode: 0o700 });
          const temporary = `${receipt}.tmp`;
          await writeFile(temporary, digest, { mode: 0o600 });
          await rename(temporary, receipt);
          console.log(
            `${new Date().toISOString()} INFO Article backup uploaded: ${user.name}/${payload.jobId}`,
          );
        } catch (error) {
          failures++;
          failure(
            `${user.name}/${file} failed; retained locally for retry`,
            error,
          );
        }
      }
    }
    return failures;
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
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
    backup.jobId !== idSchema.parse(id)
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
    await writeFile(temporary, JSON.stringify(job, null, 2), {
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
