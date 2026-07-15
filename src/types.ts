export type JobStage =
  | "queued"
  | "resolving"
  | "downloading"
  | "transcribing"
  | "writing"
  | "complete"
  | "failed";

export interface Episode {
  spotifyUrl: string;
  title: string;
  podcast: string;
  description?: string;
  imageUrl?: string;
  audioUrl: string;
  durationSeconds?: number;
  publishedAt?: string;
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
  spotifyUrl: string;
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
