import { describe, expect, it } from "vitest";
import { selectBestEpisode, validateSpotifyUrl } from "./resolver.js";

describe("Spotify resolver", () => {
  it("accepts episode URLs and strips tracking parameters", () => {
    expect(validateSpotifyUrl("https://open.spotify.com/episode/abc123?si=tracking").toString()).toBe("https://open.spotify.com/episode/abc123");
  });

  it("rejects non-Spotify and playlist links", () => {
    expect(() => validateSpotifyUrl("https://example.com/episode/abc")).toThrow();
    expect(() => validateSpotifyUrl("https://open.spotify.com/playlist/abc")).toThrow();
  });

  it("selects the closest public episode", () => {
    const selected = selectBestEpisode("De toekomst van openbaar vervoer", [
      { trackName: "Sport van vandaag", episodeUrl: "https://cdn.example/sport.mp3" },
      { trackName: "De toekomst van het openbaar vervoer", episodeUrl: "https://cdn.example/transit.mp3" },
    ]);
    expect(selected?.episodeUrl).toContain("transit");
  });
});
