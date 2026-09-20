import type { Episode, Job } from "../types.js";

export const maxArticleRetries = 2;

// Old fields are accepted only at the storage boundary, never in live jobs or APIs.
interface StoredEpisode extends Partial<Episode> {
  title: string;
  spotifyUrl?: string;
  podcast?: string;
  audioUrl?: string;
}

export interface StoredJob extends Omit<Job, "sourceUrl" | "episode"> {
  sourceUrl?: string;
  spotifyUrl?: string;
  episode?: StoredEpisode;
}

export function normalizeStoredJob(stored: StoredJob): Job {
  const { spotifyUrl, episode, ...fields } = stored;
  const job: Job = {
    ...fields,
    sourceUrl: stored.sourceUrl ?? spotifyUrl ?? "",
  };
  if (episode) {
    const { spotifyUrl: episodeUrl, podcast, audioUrl, ...source } = episode;
    job.episode = {
      ...source,
      sourceUrl: source.sourceUrl ?? episodeUrl ?? job.sourceUrl,
      sourceType: source.sourceType ?? "spotify",
      sourceName: source.sourceName ?? podcast ?? "Onbekende podcast",
      mediaUrl: source.mediaUrl ?? audioUrl ?? "",
      playbackUrl: source.playbackUrl ?? audioUrl,
    };
  }
  if (job.articleRetryAttempts === undefined) {
    // Older jobs have no counter.
    // Provider retries share an operation ID.
    // Only complete history proves the initial generation was recorded; partial histories and restarted generations count conservatively.
    const operations = new Set(
      (job.apiUsage?.requests ?? [])
        .filter(
          (request) =>
            request.stage === "article" &&
            typeof request.operationId === "string" &&
            request.operationId.length > 0,
        )
        .map((request) => request.operationId),
    );
    const initialGeneration = job.apiUsage?.coverage === "complete" ? 1 : 0;
    job.articleRetryAttempts = Math.max(0, operations.size - initialGeneration);
  } else if (
    !Number.isSafeInteger(job.articleRetryAttempts) ||
    job.articleRetryAttempts < 0
  ) {
    // Invalid persisted limits must not enable additional paid work.
    job.articleRetryAttempts = maxArticleRetries;
  }
  if (job.stage === "complete") {
    job.completedAt ??= job.updatedAt;
  }
  if (
    job.readingPosition &&
    (!Number.isInteger(job.readingPosition.sectionIndex) ||
      job.readingPosition.sectionIndex < 0 ||
      !job.article ||
      job.readingPosition.sectionIndex >= job.article.sections.length ||
      !Number.isFinite(Date.parse(job.readingPosition.updatedAt)))
  ) {
    delete job.readingPosition;
  }
  return job;
}
