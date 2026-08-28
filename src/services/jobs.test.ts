import { describe, expect, it } from "vitest";
import {
  compareArticleSummaries,
  findDuplicateJob,
  normalizeStoredJob,
  playbackFileForJob,
  toArticleSummary,
  toProcessingJobSummary,
} from "./jobs.js";
import type { ArticleSummary, Job } from "../types.js";

describe("stored job compatibility", () => {
  it("upgrades Spotify jobs created before generic source support", () => {
    const legacy = {
      id: "11111111-1111-1111-1111-111111111111",
      spotifyUrl: "https://open.spotify.com/episode/abc123",
      language: "nl",
      articleLength: "standard",
      stage: "complete",
      progress: 100,
      message: "Klaar",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      episode: {
        spotifyUrl: "https://open.spotify.com/episode/abc123",
        title: "Een aflevering",
        podcast: "Een podcast",
        audioUrl: "https://cdn.example.com/episode.mp3",
      },
    } as unknown as Job;

    const job = normalizeStoredJob(legacy);

    expect(job.sourceUrl).toBe(legacy.spotifyUrl);
    expect(job.completedAt).toBe(legacy.updatedAt);
    expect(job.episode).toMatchObject({
      sourceType: "spotify",
      sourceUrl: legacy.spotifyUrl,
      sourceName: "Een podcast",
      mediaUrl: "https://cdn.example.com/episode.mp3",
      playbackUrl: "https://cdn.example.com/episode.mp3",
    });
  });

  it("keeps a valid heading-based reading position", () => {
    const job = {
      id: "11111111-1111-1111-1111-111111111111",
      sourceUrl: "https://youtube.com/watch?v=abc123",
      language: "nl",
      articleLength: "standard",
      stage: "complete",
      progress: 100,
      message: "Klaar",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      readingPosition: {
        sectionIndex: 1,
        updatedAt: "2026-01-02T00:00:00.000Z",
      },
      article: {
        title: "Artikel",
        dek: "Introductie",
        readingTimeMinutes: 5,
        styleNote: "Helder",
        sections: [
          { heading: "Eerste", paragraphs: [] },
          { heading: "Tweede", paragraphs: [] },
        ],
        takeaways: [],
      },
    } satisfies Job;

    expect(normalizeStoredJob(job).readingPosition).toEqual({
      sectionIndex: 1,
      updatedAt: "2026-01-02T00:00:00.000Z",
    });
  });

  it("drops a stored reading position that no longer matches the article", () => {
    const job = {
      id: "11111111-1111-1111-1111-111111111111",
      sourceUrl: "https://youtube.com/watch?v=abc123",
      language: "nl",
      articleLength: "standard",
      stage: "complete",
      progress: 100,
      message: "Klaar",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      readingPosition: {
        sectionIndex: 4,
        updatedAt: "2026-01-02T00:00:00.000Z",
      },
      article: {
        title: "Artikel",
        dek: "Introductie",
        readingTimeMinutes: 5,
        styleNote: "Helder",
        sections: [{ heading: "Enige", paragraphs: [] }],
        takeaways: [],
      },
    } satisfies Job;

    expect(normalizeStoredJob(job).readingPosition).toBeUndefined();
  });
});

describe("user storage isolation", () => {
  it("uses a different media path for every user", () => {
    const id = "11111111-1111-1111-1111-111111111111";
    expect(playbackFileForJob("rogier", id)).toContain("/users/rogier/media/");
    expect(playbackFileForJob("melvin", id)).toContain("/users/melvin/media/");
    expect(playbackFileForJob("rogier", id)).not.toBe(
      playbackFileForJob("melvin", id),
    );
  });

  it("rejects usernames that could escape the data directory", () => {
    expect(() =>
      playbackFileForJob("../pascal", "11111111-1111-1111-1111-111111111111"),
    ).toThrow(/gebruikersnaam/);
  });
});

describe("duplicate source detection", () => {
  const baseJob = {
    id: "11111111-1111-1111-1111-111111111111",
    sourceUrl: "https://open.spotify.com/episode/abc123",
    spotifyUrl: "https://open.spotify.com/episode/abc123",
    language: "nl",
    articleLength: "standard",
    stage: "complete",
    progress: 100,
    message: "Klaar",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:05:00.000Z",
  } satisfies Job;

  it("recognizes the same Spotify episode despite tracking parameters", () => {
    expect(
      findDuplicateJob(
        [baseJob],
        "https://open.spotify.com/episode/abc123?si=tracking",
      ),
    ).toBe(baseJob);
  });

  it("recognizes alternate URLs for the same YouTube video", () => {
    const youtubeJob = {
      ...baseJob,
      sourceUrl: "https://youtu.be/jNQXAC9IVRw?t=12",
    } satisfies Job;

    expect(
      findDuplicateJob(
        [youtubeJob],
        "https://www.youtube.com/watch?v=jNQXAC9IVRw&feature=share",
      ),
    ).toBe(youtubeJob);
  });

  it("allows a source to be submitted again after a failed job", () => {
    const failedJob = { ...baseJob, stage: "failed" } satisfies Job;

    expect(
      findDuplicateJob([failedJob], "https://open.spotify.com/episode/abc123"),
    ).toBeUndefined();
  });

  it("recognizes a Fathom share link despite tab and timestamp parameters", () => {
    const fathomJob = {
      ...baseJob,
      sourceUrl: "https://fathom.video/share/Test_recording?tab=summary",
    } satisfies Job;

    expect(
      findDuplicateJob(
        [fathomJob],
        "https://www.fathom.video/share/Test_recording?t=30",
      ),
    ).toBe(fathomJob);
    expect(
      findDuplicateJob(
        [fathomJob],
        "https://fathom.video/share/Another_recording",
      ),
    ).toBeUndefined();
  });

  it("prefers the completed article when duplicate stored jobs already exist", () => {
    const processingJob = {
      ...baseJob,
      id: "22222222-2222-2222-2222-222222222222",
      stage: "writing",
      createdAt: "2026-01-02T00:00:00.000Z",
    } satisfies Job;

    expect(
      findDuplicateJob(
        [processingJob, baseJob],
        "https://open.spotify.com/episode/abc123",
      ),
    ).toBe(baseJob);
  });
});

describe("article summaries", () => {
  it("only exposes the fields needed by the ready-to-read overview", () => {
    const job = {
      id: "11111111-1111-1111-1111-111111111111",
      sourceUrl: "https://youtube.com/watch?v=abc123",
      language: "nl",
      articleLength: "standard",
      stage: "complete",
      progress: 100,
      message: "Klaar",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-03T00:00:00.000Z",
      completedAt: "2026-01-02T00:00:00.000Z",
      readAt: "2026-01-03T00:00:00.000Z",
      episode: {
        sourceType: "youtube",
        sourceUrl: "https://youtube.com/watch?v=abc123",
        sourceName: "Voorbeeldkanaal",
        title: "De opname",
        imageUrl: "https://example.com/cover.jpg",
        mediaUrl: "https://example.com/audio.mp3",
        publishedAt: "2025-12-20T00:00:00.000Z",
      },
      article: {
        title: "Een leesbaar artikel",
        dek: "De korte introductie.",
        readingTimeMinutes: 7,
        styleNote: "Helder en bondig.",
        sections: [],
        takeaways: [],
      },
      transcript: [
        {
          id: "s1",
          start: 0,
          end: 1,
          speaker: "A",
          text: "Private transcript text",
        },
      ],
    } satisfies Job;

    expect(toArticleSummary(job)).toEqual({
      id: job.id,
      title: "Een leesbaar artikel",
      dek: "De korte introductie.",
      readingTimeMinutes: 7,
      sourceName: "Voorbeeldkanaal",
      sourceType: "youtube",
      imageUrl: "https://example.com/cover.jpg",
      publishedAt: "2025-12-20T00:00:00.000Z",
      completedAt: "2026-01-02T00:00:00.000Z",
      readAt: "2026-01-03T00:00:00.000Z",
    });
  });

  it("ignores jobs that are not ready to read", () => {
    const job = {
      id: "11111111-1111-1111-1111-111111111111",
      sourceUrl: "https://youtube.com/watch?v=abc123",
      language: "nl",
      articleLength: "standard",
      stage: "writing",
      progress: 82,
      message: "Schrijven",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    } satisfies Job;

    expect(toArticleSummary(job)).toBeUndefined();
  });

  it("sorts read articles by their full read timestamp in descending order", () => {
    const base = {
      title: "Een leesbaar artikel",
      dek: "De korte introductie.",
      readingTimeMinutes: 7,
      sourceName: "Voorbeeldkanaal",
      sourceType: "youtube",
      completedAt: "2026-01-02T00:00:00.000Z",
    } satisfies Omit<ArticleSummary, "id" | "readAt">;
    const articles = [
      {
        ...base,
        id: "11111111-1111-1111-1111-111111111111",
        readAt: "2026-01-03T09:15:00.000Z",
      },
      {
        ...base,
        id: "22222222-2222-2222-2222-222222222222",
        readAt: "2026-01-03T18:45:00.000Z",
      },
    ] satisfies ArticleSummary[];

    articles.sort(compareArticleSummaries);

    expect(articles.map((article) => article.id)).toEqual([
      "22222222-2222-2222-2222-222222222222",
      "11111111-1111-1111-1111-111111111111",
    ]);
  });
});

describe("processing summaries", () => {
  it("exposes progress without transcript or source URLs", () => {
    const job = {
      id: "11111111-1111-1111-1111-111111111111",
      sourceUrl: "https://youtube.com/watch?v=abc123",
      language: "nl",
      articleLength: "standard",
      stage: "transcribing",
      progress: 54,
      message: "Transcriptie 2/4",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:05:00.000Z",
      episode: {
        sourceType: "youtube",
        sourceUrl: "https://youtube.com/watch?v=abc123",
        sourceName: "Voorbeeldkanaal",
        title: "De opname",
        mediaUrl: "https://example.com/audio.mp3",
      },
      transcript: [
        {
          id: "s1",
          start: 0,
          end: 1,
          speaker: "A",
          text: "Private transcript text",
        },
      ],
    } satisfies Job;

    expect(toProcessingJobSummary(job)).toEqual({
      id: job.id,
      title: "De opname",
      sourceName: "Voorbeeldkanaal",
      imageUrl: undefined,
      stage: "transcribing",
      progress: 54,
      message: "Transcriptie 2/4",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it("does not include completed or failed jobs", () => {
    const base = {
      id: "11111111-1111-1111-1111-111111111111",
      sourceUrl: "https://youtube.com/watch?v=abc123",
      language: "nl",
      articleLength: "standard",
      progress: 100,
      message: "Klaar",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:05:00.000Z",
    } satisfies Omit<Job, "stage">;

    expect(
      toProcessingJobSummary({ ...base, stage: "complete" }),
    ).toBeUndefined();
    expect(
      toProcessingJobSummary({ ...base, stage: "failed" }),
    ).toBeUndefined();
  });
});
