import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { DomainError } from "../lib/errors.js";
import {
  articleSchema,
  episodeSchema,
  jobStageSchema,
  transcriptSchema,
} from "../shared/api.js";
import type { ApiUsageMetrics, Job } from "../types.js";

export const maxArticleRetries = 2;
const schemaVersion = 1;
export const usernameSchema = z.string().regex(/^[a-z][a-z0-9_-]{1,31}$/);
export const jobIdSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
export const shareTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const timestamp = z
  .string()
  .refine((value) => Number.isFinite(Date.parse(value)));
const nonnegative = z.number().nonnegative();
const nonempty = z.string().min(1);
const httpUrl = z.url({ protocol: /^https?$/ });
const playbackUrl = z.union([
  httpUrl,
  z.string().regex(/^\/api\/jobs\/[0-9a-f-]{36}\/audio$/i),
]);

function metricsSchema(depth: number): z.ZodType<ApiUsageMetrics> {
  return z.record(
    z.string(),
    depth === 0
      ? nonnegative
      : z.union([nonnegative, metricsSchema(depth - 1)]),
  );
}

const usageMetrics = metricsSchema(3);
const requestUsage = z.object({
  id: nonempty,
  operationId: nonempty,
  attempt: z.int().positive(),
  stage: z.enum(["transcription", "article"]),
  chunkNumber: z.int().positive().optional(),
  requestedModel: nonempty,
  actualModel: z.string().optional(),
  requestedServiceTier: nonempty,
  initialServiceTier: nonempty.optional(),
  actualServiceTier: z.string().optional(),
  endpointRegion: z.enum(["global", "eu", "us", "custom"]),
  startedAt: timestamp,
  finishedAt: timestamp.optional(),
  elapsedMs: nonnegative.optional(),
  status: z.enum(["pending", "succeeded", "failed", "aborted"]),
  responseStatus: z.string().optional(),
  httpStatus: z.int().min(100).max(599).optional(),
  requestId: z.string().optional(),
  errorCode: z.string().optional(),
  errorMessage: z.string().optional(),
  usage: usageMetrics.optional(),
  audioSeconds: nonnegative.optional(),
  reservedCostUsd: nonnegative.optional(),
  cost: z.object({
    currency: z.literal("USD"),
    amount: nonnegative.nullable(),
    reason: z.string().optional(),
    basis: z.string().optional(),
    pricingDate: z.string().optional(),
    pricingSource: z.string().optional(),
    rates: z.record(z.string(), nonnegative).optional(),
  }),
});
const apiUsage = z
  .object({
    trackingStartedAt: timestamp,
    coverage: z.enum(["complete", "partial"]),
    requests: z.array(requestUsage),
    knownEstimatedCostUsd: nonnegative,
    unknownCostRequests: z.int().nonnegative(),
  })
  .refine(({ requests, knownEstimatedCostUsd, unknownCostRequests }) => {
    const ids = new Set<string>();
    let known = 0;
    let unknown = 0;
    for (const request of requests) {
      ids.add(request.id);
      if (request.cost.amount === null) {
        unknown++;
      } else {
        known += request.cost.amount;
      }
    }
    return (
      ids.size === requests.length &&
      known === knownEstimatedCostUsd &&
      unknown === unknownCostRequests
    );
  });
const backgroundArticle = z.object({
  responseId: nonempty,
  baseURL: httpUrl,
  status: nonempty,
  error: z.object({ code: z.string(), message: z.string() }).optional(),
  incompleteReason: z.string().optional(),
  answer: z.string().optional(),
  request: requestUsage.extend({ stage: z.literal("article") }),
});

const storedEpisode = z.object(episodeSchema.shape).extend({
  sourceUrl: httpUrl,
  feedUrl: httpUrl.optional(),
  mediaUrl: z.union([httpUrl, z.literal("")]),
  playbackUrl: playbackUrl.optional(),
  imageUrl: httpUrl.optional(),
  durationSeconds: nonnegative.optional(),
});

const jobSchema = z.object({
  id: jobIdSchema,
  sourceUrl: httpUrl,
  language: nonempty,
  articleLength: z.enum(["compact", "standard", "long"]),
  stage: jobStageSchema,
  progress: nonnegative.max(100),
  message: z.string(),
  messageValues: z
    .record(z.string(), z.union([z.string(), z.number()]))
    .optional(),
  createdAt: timestamp,
  updatedAt: timestamp,
  completedAt: timestamp.optional(),
  readAt: timestamp.optional(),
  readingPosition: z
    .object({
      sectionIndex: z.int().nonnegative(),
      updatedAt: timestamp,
    })
    .optional(),
  deletedAt: timestamp.optional(),
  shareToken: shareTokenSchema.optional(),
  shareAnalytics: z
    .object({
      loads: z.int().nonnegative(),
      reads: z.int().nonnegative(),
      lastLoadedAt: timestamp.optional(),
      lastReadAt: timestamp.optional(),
      recentVisits: z.array(
        z.object({
          digest,
          loadedAt: nonnegative,
          read: z.boolean(),
        }),
      ),
    })
    .optional(),
  savedShareKey: digest.optional(),
  podcastEpisodeKey: nonempty.optional(),
  episode: storedEpisode.optional(),
  transcript: z.optional(transcriptSchema),
  article: z.optional(articleSchema),
  backgroundArticle: backgroundArticle.optional(),
  articleQuoteRepairs: z.array(backgroundArticle).optional(),
  error: z.string().optional(),
  failedStage: z.optional(jobStageSchema),
  articleRetryAttempts: z.int().nonnegative(),
  apiUsage: apiUsage.optional(),
}) satisfies z.ZodType<Job>;

const legacyJobSchema = jobSchema.extend({
  sourceUrl: httpUrl.optional(),
  spotifyUrl: httpUrl.optional(),
  episode: storedEpisode
    .partial({
      sourceType: true,
      sourceUrl: true,
      sourceName: true,
      mediaUrl: true,
    })
    .extend({
      spotifyUrl: httpUrl.optional(),
      podcast: z.string().optional(),
      audioUrl: z.union([httpUrl, z.literal("")]).optional(),
    })
    .optional(),
  articleRetryAttempts: jobSchema.shape.articleRetryAttempts.optional(),
  schemaVersion: z.undefined().optional(),
  owner: usernameSchema.optional(),
  listeningPosition: z.unknown().optional(),
});

const versionedJobSchema = jobSchema.extend({
  schemaVersion: z.literal(schemaVersion),
  owner: usernameSchema,
  // Explicit null marks records from before usage tracking and content-only restores.
  apiUsage: apiUsage.nullable(),
});

function normalizeStoredJob(stored: z.output<typeof legacyJobSchema>) {
  const {
    spotifyUrl,
    episode,
    listeningPosition: _listeningPosition,
    owner: _owner,
    schemaVersion: _version,
    ...fields
  } = stored;
  const sourceUrl = stored.sourceUrl ?? spotifyUrl;
  let normalizedEpisode: Job["episode"] | undefined;
  if (episode && sourceUrl) {
    const { spotifyUrl: episodeUrl, podcast, audioUrl, ...source } = episode;
    normalizedEpisode = {
      ...source,
      sourceUrl: source.sourceUrl ?? episodeUrl ?? sourceUrl,
      sourceType: source.sourceType ?? "spotify",
      sourceName: source.sourceName ?? podcast ?? "Onbekende podcast",
      mediaUrl: source.mediaUrl ?? audioUrl ?? "",
      playbackUrl: source.playbackUrl ?? (audioUrl || undefined),
    };
  }
  // Provider retries share an operation ID.
  // Only complete history proves the initial generation was recorded.
  const articleRetryAttempts =
    stored.articleRetryAttempts ?? inferArticleRetries(stored.apiUsage);
  const completedAt =
    stored.completedAt ??
    (stored.stage === "complete" ? stored.updatedAt : undefined);
  return {
    ...fields,
    sourceUrl,
    episode: normalizedEpisode,
    completedAt,
    articleRetryAttempts,
  };
}

function inferArticleRetries(usage: Job["apiUsage"]): number {
  const operations = new Set(
    (usage?.requests ?? [])
      .filter((request) => request.stage === "article")
      .map((request) => request.operationId),
  );
  const initialGeneration = usage?.coverage === "complete" ? 1 : 0;
  return Math.max(0, operations.size - initialGeneration);
}

type InvalidRecordReason =
  | "malformed JSON"
  | "unsupported schema version"
  | "owner or job ID does not match the path"
  | "invalid job fields"
  | "invalid article or transcript values"
  | "missing required stage data"
  | "playback URL does not match the job ID";

export class StoredJobError extends DomainError {
  constructor(
    code: "error.jobRecordInvalid" | "error.jobStorageUnavailable",
    public readonly reason: InvalidRecordReason | "filesystem read failed",
  ) {
    super(code);
    this.name = "StoredJobError";
  }
}

function invalid(reason: InvalidRecordReason): never {
  throw new StoredJobError("error.jobRecordInvalid", reason);
}

function validateJobState(job: Job): Job {
  const { stage, episode, transcript, article, readingPosition } = job;
  if (
    (["downloading", "transcribing", "writing", "complete"].includes(stage) &&
      !episode) ||
    (["downloading", "transcribing"].includes(stage) && !episode?.mediaUrl) ||
    ((stage === "writing" ||
      job.backgroundArticle ||
      job.articleQuoteRepairs?.length) &&
      (!episode || !transcript?.length)) ||
    (stage === "complete" && (!article || !transcript || !job.completedAt)) ||
    (transcript && !episode)
  ) {
    invalid("missing required stage data");
  }
  if (
    (article && article.readingTimeMinutes < 0) ||
    transcript?.some(({ id, start, end }) => !id || start < 0 || end < start)
  ) {
    invalid("invalid article or transcript values");
  }
  if (
    episode?.playbackUrl?.startsWith("/") &&
    episode.playbackUrl !== `/api/jobs/${job.id}/audio`
  ) {
    invalid("playback URL does not match the job ID");
  }
  // A saved position can refer to a section removed by an older article revision.
  if (
    readingPosition &&
    (!article || readingPosition.sectionIndex >= article.sections.length)
  ) {
    delete job.readingPosition;
  }
  return job;
}

export function parseStoredJob(input: unknown, owner: string, id: string): Job {
  const header = z
    .object({
      id: jobIdSchema,
      owner: usernameSchema.optional(),
      schemaVersion: z.unknown().optional(),
    })
    .safeParse(input);
  if (!header.success) {
    invalid("invalid job fields");
  }
  if (
    header.data.id !== id ||
    (header.data.owner !== undefined && header.data.owner !== owner)
  ) {
    invalid("owner or job ID does not match the path");
  }
  if (header.data.schemaVersion === undefined) {
    const legacy = legacyJobSchema.safeParse(input);
    if (!legacy.success) {
      invalid("invalid job fields");
    }
    const normalized = jobSchema.safeParse(normalizeStoredJob(legacy.data));
    if (!normalized.success) {
      invalid("invalid job fields");
    }
    return validateJobState(normalized.data);
  }
  if (header.data.schemaVersion !== schemaVersion) {
    invalid("unsupported schema version");
  }
  const current = versionedJobSchema.safeParse(input);
  if (!current.success) {
    invalid("invalid job fields");
  }
  const {
    schemaVersion: _version,
    owner: _owner,
    apiUsage: usage,
    ...job
  } = current.data;
  return validateJobState({ ...job, apiUsage: usage ?? undefined });
}

export function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export async function readStoredJob(
  directory: string,
  owner: string,
  id: string,
): Promise<Job | undefined> {
  let contents: string;
  try {
    contents = await readFile(
      path.join(directory, `${jobIdSchema.parse(id)}.json`),
      "utf8",
    );
  } catch (error) {
    if (isMissingFile(error)) {
      return undefined;
    }
    throw new StoredJobError(
      "error.jobStorageUnavailable",
      "filesystem read failed",
    );
  }

  let input: unknown;
  try {
    input = JSON.parse(contents);
  } catch {
    invalid("malformed JSON");
  }
  return parseStoredJob(input, owner, id);
}

export function serializeStoredJob(owner: string, job: Job): string {
  return JSON.stringify(
    {
      ...job,
      schemaVersion,
      owner,
      articleRetryAttempts: job.articleRetryAttempts ?? 0,
      apiUsage: job.apiUsage ?? null,
    },
    null,
    2,
  );
}
