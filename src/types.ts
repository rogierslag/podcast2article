export type JobStage =
  | "queued"
  | "resolving"
  | "downloading"
  | "transcribing"
  | "writing"
  | "complete"
  | "failed";

export type SourceType = "spotify" | "google-drive" | "youtube";

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
  episode?: Episode;
  transcript?: TranscriptSegment[];
  article?: Article;
  error?: string;
}
