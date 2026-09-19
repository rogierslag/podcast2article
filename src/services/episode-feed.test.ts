import { beforeEach, expect, it, vi } from "vitest";
import { safeFetch } from "../lib/network.js";
import { findEpisodeFeed, resolveSpotifyEpisode } from "./resolver.js";
import type { Episode } from "../types.js";
vi.mock("../lib/network.js", () => ({ safeFetch: vi.fn() }));
const episode: Episode = {
  sourceType: "spotify",
  sourceUrl: "https://open.spotify.com/episode/example",
  sourceName: "Public podcast",
  title: "Same episode title",
  mediaUrl: "https://example.com/audio.mp3",
};
beforeEach(() => vi.resetAllMocks());
it("recovers a feed from the stored audio identity, never just a matching title", async () => {
  vi.mocked(safeFetch).mockImplementation(async () =>
    Response.json({
      results: [
        {
          trackName: episode.title,
          episodeUrl: "https://other.example/audio.mp3",
          feedUrl: "https://other.example/feed",
        },
        {
          trackName: episode.title,
          episodeUrl: episode.mediaUrl,
          feedUrl: "https://example.com/feed",
        },
      ],
    }),
  );

  expect(await findEpisodeFeed(episode)).toBe("https://example.com/feed");
  expect(
    await findEpisodeFeed({
      ...episode,
      mediaUrl: "https://unknown.example/audio.mp3",
    }),
  ).toBeUndefined();
});
it("retains the feed for newly resolved Spotify episodes", async () => {
  vi.mocked(safeFetch)
    .mockResolvedValueOnce(Response.json({ title: episode.title }))
    .mockResolvedValueOnce(
      Response.json({
        results: [
          {
            trackName: episode.title,
            episodeUrl: episode.mediaUrl,
            feedUrl: "https://example.com/feed",
          },
        ],
      }),
    );

  expect((await resolveSpotifyEpisode(episode.sourceUrl)).feedUrl).toBe(
    "https://example.com/feed",
  );
});
