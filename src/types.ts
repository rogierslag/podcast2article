export type JobStage =
  | "queued"
  | "resolving"
  | "downloading"
  | "transcribing"
  | "writing"
  | "complete"
  | "failed";

export type ProcessingStage = Exclude<JobStage, "complete" | "failed">;

export type SourceType =
  "spotify" | "rss" | "google-drive" | "youtube" | "fathom";

export interface Episode {
  sourceType: SourceType;
  sourceUrl: string;
  sourceName: string;
  title: string;
  description?: string;
  imageUrl?: string;
  mediaUrl: string;
  playbackUrl?: string;
  durationSeconds?: number;
  publishedAt?: string;
  /** Legacy fields retained while loading jobs created before generic sources. */
  spotifyUrl?: string;
  podcast?: string;
  audioUrl?: string;
}

export interface TranscriptSegment {
  id: string;
  start: number;
  end: number;
  speaker: string;
  text: string;
}

export interface ArticleParagraph {
  /** Optional for compatibility with articles created before typed content blocks. */
  kind?: "paragraph" | "quote";
  text: string;
  sources: string[];
}

export interface Article {
  title: string;
  dek: string;
  readingTimeMinutes: number;
  styleNote: string;
  sections: Array<{ heading: string; paragraphs: ArticleParagraph[] }>;
  takeaways: ArticleParagraph[];
}

export interface ArticleReadingPosition {
  sectionIndex: number;
  updatedAt: string;
}

export interface ApiUsageMetrics {
  [key: string]: number | ApiUsageMetrics;
}

export interface ApiCostEstimate {
  currency: "USD";
  amount: number | null;
  reason?: string;
  basis?: string;
  pricingDate?: string;
  pricingSource?: string;
  rates?: Record<string, number>;
}

export interface ApiRequestUsage {
  id: string;
  operationId: string;
  attempt: number;
  stage: "transcription" | "article";
  chunkNumber?: number;
  requestedModel: string;
  actualModel?: string;
  requestedServiceTier: string;
  actualServiceTier?: string;
  endpointRegion: "global" | "eu" | "us" | "custom";
  startedAt: string;
  finishedAt?: string;
  elapsedMs?: number;
  status: "pending" | "succeeded" | "failed" | "aborted";
  responseStatus?: string;
  httpStatus?: number;
  requestId?: string;
  errorCode?: string;
  usage?: ApiUsageMetrics;
  audioSeconds?: number;
  cost: ApiCostEstimate;
}

export interface JobApiUsage {
  trackingStartedAt: string;
  coverage: "complete" | "partial";
  requests: ApiRequestUsage[];
  /** Sum of known estimates only; never interpret as an invoice total. */
  knownEstimatedCostUsd: number;
  unknownCostRequests: number;
}

export interface Job {
  id: string;
  sourceUrl: string;
  /** Legacy field retained while loading jobs created before generic sources. */
  spotifyUrl?: string;
  language: string;
  articleLength: "compact" | "standard" | "long";
  stage: JobStage;
  progress: number;
  message: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  readAt?: string;
  readingPosition?: ArticleReadingPosition;
  /** Soft deletion hides the article without removing its stored content or media. */
  deletedAt?: string;
  /** High-entropy capability token for the article's anonymous public permalink. */
  shareToken?: string;
  /** Digest used to deduplicate personal copies of shared articles. */
  savedShareKey?: string;
  /** Stable feed + episode identity, independent of changing enclosure URLs. */
  podcastEpisodeKey?: string;
  episode?: Episode;
  transcript?: TranscriptSegment[];
  article?: Article;
  error?: string;
  apiUsage?: JobApiUsage;
}

export interface PodcastEpisode {
  key: string;
  episode: Episode;
}

export interface PodcastFeed {
  url: string;
  title: string;
  episodes: PodcastEpisode[];
}

export type Backfill = "none" | "latest" | "ten";

export interface PodcastSubscription {
  id: string;
  feedUrl: string;
  title: string;
  language: string;
  articleLength: Job["articleLength"];
  paused: boolean;
  pauseReason?: "limit";
  archiveKeys?: string[];
  createdAt: string;
  checkedAt?: string;
  error?: string;
  seen: string[];
  jobIds: string[];
  pending: PodcastEpisode[];
}

export interface ArticleSummary {
  id: string;
  title: string;
  dek: string;
  readingTimeMinutes: number;
  sourceName: string;
  sourceType: SourceType;
  imageUrl?: string;
  publishedAt?: string;
  completedAt: string;
  readAt?: string;
}

export interface ProcessingJobSummary {
  id: string;
  title: string;
  sourceName: string;
  imageUrl?: string;
  stage: ProcessingStage;
  progress: number;
  message: string;
  createdAt: string;
}
