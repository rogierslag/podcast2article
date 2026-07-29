import { describe, expect, it } from "vitest";
import { normalizeStoredJob } from "./jobs.js";
import type { Job } from "../types.js";

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
    expect(job.episode).toMatchObject({
      sourceType: "spotify",
      sourceUrl: legacy.spotifyUrl,
      sourceName: "Een podcast",
      mediaUrl: "https://cdn.example.com/episode.mp3",
      playbackUrl: "https://cdn.example.com/episode.mp3",
    });
  });
});
