import * as z from "zod/mini";
import type {
  Article,
  ArticleSummary,
  Episode,
  Job,
  ProcessingJobSummary,
  TranscriptSegment,
  AccountBudget,
} from "../types.js";
export type ClientJob = Pick<Job, "id" | "progress" | "message"> &
  Partial<
    Pick<
      Job,
      | "sourceUrl"
      | "language"
      | "articleLength"
      | "stage"
      | "episode"
      | "article"
      | "transcript"
      | "savedShareKey"
      | "articleRetryAttempts"
      | "readingPosition"
      | "readAt"
      | "error"
    >
  >;
export type CompletedClientJob = ClientJob & {
  episode: Episode;
  article: Article;
  transcript: TranscriptSegment[];
};
export interface SharedArticle {
  article: Article;
  episode: Pick<
    Episode,
    | "sourceType"
    | "sourceUrl"
    | "sourceName"
    | "title"
    | "imageUrl"
    | "durationSeconds"
    | "publishedAt"
  >;
  sources: Pick<TranscriptSegment, "id" | "start">[];
}
const sourceType = z.enum([
  "spotify",
  "rss",
  "google-drive",
  "youtube",
  "fathom",
]);
const stage = z.enum([
  "queued",
  "resolving",
  "downloading",
  "transcribing",
  "writing",
  "complete",
  "failed",
]);
const paragraph = z.object({
  kind: z.optional(z.enum(["paragraph", "quote"])),
  text: z.string(),
  sources: z.array(z.string()),
});
export const articleSchema = z.object({
  title: z.string(),
  dek: z.string(),
  readingTimeMinutes: z.number(),
  styleNote: z.string(),
  sections: z.array(
    z.object({ heading: z.string(), paragraphs: z.array(paragraph) }),
  ),
  takeaways: z.array(paragraph),
}) satisfies z.ZodMiniType<Article>;
const episodeSchema = z.object({
  sourceType,
  sourceUrl: z.string(),
  sourceName: z.string(),
  title: z.string(),
  mediaUrl: z.string(),
  description: z.optional(z.string()),
  feedUrl: z.optional(z.string()),
  playbackUrl: z.optional(z.string()),
  imageUrl: z.optional(z.string()),
  durationSeconds: z.optional(z.number()),
  publishedAt: z.optional(z.string()),
}) satisfies z.ZodMiniType<Episode>;
const transcriptSchema = z.array(
  z.object({
    id: z.string(),
    start: z.number(),
    end: z.number(),
    speaker: z.string(),
    text: z.string(),
  }),
);
export const readingPositionSchema = z.object({
  sectionIndex: z.int().check(z.nonnegative()),
  updatedAt: z.optional(z.string()),
});
export const jobSchema = z.object({
  id: z.string(),
  progress: z.number(),
  message: z.string(),
  sourceUrl: z.optional(z.string()),
  language: z.optional(z.string()),
  articleLength: z.optional(z.enum(["compact", "standard", "long"])),
  stage,
  episode: z.optional(episodeSchema),
  article: z.optional(articleSchema),
  transcript: z.optional(transcriptSchema),
  savedShareKey: z.optional(z.string()),
  articleRetryAttempts: z.optional(z.number()),
  readingPosition: z.optional(
    z.extend(readingPositionSchema, { updatedAt: z.string() }),
  ),
  readAt: z.optional(z.string()),
  error: z.optional(z.string()),
}) satisfies z.ZodMiniType<ClientJob>;
export const articleSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  dek: z.string(),
  readingTimeMinutes: z.number(),
  sourceName: z.string(),
  sourceType,
  imageUrl: z.optional(z.string()),
  publishedAt: z.optional(z.string()),
  completedAt: z.string(),
  readAt: z.optional(z.string()),
}) satisfies z.ZodMiniType<ArticleSummary>;
export const processingSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  sourceName: z.string(),
  imageUrl: z.optional(z.string()),
  stage: z.enum([
    "queued",
    "resolving",
    "downloading",
    "transcribing",
    "writing",
  ]),
  progress: z.number(),
  message: z.string(),
  createdAt: z.string(),
}) satisfies z.ZodMiniType<ProcessingJobSummary>;
export const sharedArticleSchema = z.object({
  article: articleSchema,
  episode: z.omit(episodeSchema, {
    mediaUrl: true,
    description: true,
    feedUrl: true,
    playbackUrl: true,
  }),
  sources: z.array(z.object({ id: z.string(), start: z.number() })),
}) satisfies z.ZodMiniType<SharedArticle>;
export const budgetSchema = z.object({
  windowDays: z.number(),
  spentUsd: z.number(),
  countedSpendUsd: z.number(),
  historicalSpendUsd: z.number(),
  reservedUsd: z.number(),
  unknownCostRequests: z.number(),
  limitUsd: z.nullable(z.number()),
  remainingUsd: z.nullable(z.number()),
}) satisfies z.ZodMiniType<AccountBudget>;
export const errorSchema = z.object({
  error: z.optional(z.string()),
  existingJobId: z.optional(z.string()),
  existingStage: z.optional(stage),
});
export const savedArticleSchema = z.object({
  articleId: z.nullable(z.string()),
});
export const shareLinkSchema = z.object({ url: z.string() });
export const shareStatsSchema = z.object({
  loads: z.int().check(z.nonnegative()),
  reads: z.int().check(z.nonnegative()),
});
export const seriesPreviewSchema = z.object({
  id: z.string(),
  url: z.string(),
  title: z.string(),
  imageUrl: z.optional(z.string()),
  count: z.number(),
  episodes: z.array(z.object({ title: z.string() })),
});
export const seriesCandidateSchema = z.object({
  url: z.string(),
  title: z.string(),
  imageUrl: z.optional(z.string()),
  author: z.optional(z.string()),
});
export const subscriptionSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  imageUrl: z.optional(z.string()),
  paused: z.boolean(),
  pauseReason: z.optional(z.literal("limit")),
  checkedAt: z.optional(z.string()),
  error: z.optional(z.string()),
  complete: z.number(),
  processing: z.number(),
  pendingCount: z.number(),
  archiveCount: z.number(),
  outstanding: z.number(),
  failed: z.array(z.object({ id: z.string(), title: z.string() })),
});
export const articleSeriesSchema = z.object({
  feedUrl: z.string(),
  subscription: z.nullable(z.object({ id: z.string(), paused: z.boolean() })),
});
/** JSON is untrusted even when it comes from our own API. */
export async function responseData<T>(
  response: Response,
  schema: z.ZodMiniType<T>,
): Promise<T> {
  const data: unknown = await response.json();
  return schema.parse(data);
}
