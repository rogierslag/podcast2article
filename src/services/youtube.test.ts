import { describe, expect, it } from "vitest";
import {
  validateYouTubeUrl,
  youtubeEpisodeFromMetadata,
  youtubeVideoId,
} from "./youtube.js";

describe("YouTube resolver", () => {
  it("accepts common video URLs and canonicalizes them", () => {
    const id = "jNQXAC9IVRw";
    expect(youtubeVideoId(`https://youtu.be/${id}?si=tracking`)).toBe(id);
    expect(youtubeVideoId(`https://www.youtube.com/shorts/${id}`)).toBe(id);
    expect(youtubeVideoId(`https://www.youtube.com/live/${id}?feature=share`)).toBe(id);
    expect(youtubeVideoId(`https://www.youtube-nocookie.com/embed/${id}`)).toBe(id);
    expect(validateYouTubeUrl(`https://m.youtube.com/watch?v=${id}&list=ignored`).toString())
      .toBe(`https://www.youtube.com/watch?v=${id}`);
  });

  it("rejects playlists, channels, malformed IDs, and lookalike hosts", () => {
    expect(() => validateYouTubeUrl("https://www.youtube.com/playlist?list=PL123")).toThrow("één video");
    expect(() => validateYouTubeUrl("https://www.youtube.com/@example")).toThrow("één video");
    expect(() => validateYouTubeUrl("https://www.youtube.com/watch?v=short")).toThrow("één video");
    expect(() => validateYouTubeUrl("https://youtube.com.example/watch?v=jNQXAC9IVRw")).toThrow("YouTube");
  });

  it("maps public metadata to a generic episode", () => {
    const sourceUrl = "https://www.youtube.com/watch?v=jNQXAC9IVRw";
    expect(youtubeEpisodeFromMetadata(sourceUrl, {
      title: "Me at the zoo",
      channel: "jawed",
      description: "A short video",
      duration: 19.4,
      thumbnail: "https://i.ytimg.com/vi/jNQXAC9IVRw/hqdefault.jpg",
      upload_date: "20050424",
      availability: "public",
      live_status: "not_live",
    })).toEqual({
      sourceType: "youtube",
      sourceUrl,
      sourceName: "jawed",
      title: "Me at the zoo",
      description: "A short video",
      imageUrl: "https://i.ytimg.com/vi/jNQXAC9IVRw/hqdefault.jpg",
      mediaUrl: sourceUrl,
      durationSeconds: 19,
      publishedAt: "2005-04-24",
    });
  });

  it("rejects private and active live videos", () => {
    expect(() => youtubeEpisodeFromMetadata("https://www.youtube.com/watch?v=jNQXAC9IVRw", {
      title: "Private",
      availability: "private",
    })).toThrow("niet openbaar");
    expect(() => youtubeEpisodeFromMetadata("https://www.youtube.com/watch?v=jNQXAC9IVRw", {
      title: "Live",
      live_status: "is_live",
    })).toThrow("Live en geplande");
  });

  it("allows an unlisted recording and ignores malformed dates and durations", () => {
    const episode = youtubeEpisodeFromMetadata("https://www.youtube.com/watch?v=jNQXAC9IVRw", {
      title: "Unlisted recording",
      availability: "unlisted",
      live_status: "was_live",
      duration: Number.NaN,
      upload_date: "unknown",
    });
    expect(episode).toMatchObject({ sourceType: "youtube", title: "Unlisted recording" });
    expect(episode.durationSeconds).toBeUndefined();
    expect(episode.publishedAt).toBeUndefined();
  });
});
