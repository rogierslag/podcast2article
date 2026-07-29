import { describe, expect, it } from "vitest";
import {
  googleDriveDownloadUrl,
  googleDriveFileId,
  parseGoogleDriveMetadata,
  selectBestEpisode,
  validateGoogleDriveUrl,
  validateSourceUrl,
  validateSpotifyUrl,
} from "./resolver.js";

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

describe("Google Drive resolver", () => {
  const fileId = "1QD_HjP7fhHApMySxYsUZlRRYiACjbp_g";

  it("accepts file links and canonicalizes sharing parameters", () => {
    expect(validateGoogleDriveUrl(`https://drive.google.com/file/d/${fileId}/view?usp=sharing`).toString())
      .toBe(`https://drive.google.com/file/d/${fileId}/view`);
    expect(googleDriveFileId(`https://drive.google.com/open?id=${fileId}`)).toBe(fileId);
    expect(validateGoogleDriveUrl(`https://drive.google.com/file/d/${fileId}/view?resourcekey=0-example_key`).toString())
      .toBe(`https://drive.google.com/file/d/${fileId}/view?resourcekey=0-example_key`);
  });

  it("rejects folders, Meet room links, and unrelated hosts", () => {
    expect(() => validateGoogleDriveUrl("https://drive.google.com/drive/folders/abc123456789")).toThrow();
    expect(() => validateGoogleDriveUrl("https://meet.google.com/abc-defg-hij")).toThrow();
    expect(() => validateGoogleDriveUrl(`https://example.com/file/d/${fileId}/view`)).toThrow();
  });

  it("reads public file metadata and keeps punctuation", () => {
    const metadata = parseGoogleDriveMetadata(
      `<meta content="Rogier's talk &amp; questions.mp4" property="og:title">` +
      `<meta property="og:image" content="https://example.com/preview.jpg">`,
    );
    expect(metadata).toEqual({
      title: "Rogier's talk & questions.mp4",
      imageUrl: "https://example.com/preview.jpg",
      mimeType: undefined,
    });
  });

  it("accepts extensionless Google Meet titles using Drive MIME metadata", () => {
    const metadata = parseGoogleDriveMetadata(
      `<meta property="og:title" content="Stop simply using AI - 2026/07/28 - Recording">` +
      `<script>window.config={"docs-dm":"video/mp4"}</script>`,
    );
    expect(metadata).toMatchObject({
      title: "Stop simply using AI - 2026/07/28 - Recording",
      mimeType: "video/mp4",
    });
  });

  it("rejects non-media Drive files", () => {
    expect(() => parseGoogleDriveMetadata(`<meta property="og:title" content="Notes.pdf">`)).toThrow();
  });

  it("builds the public media URL and dispatches both supported sources", () => {
    expect(googleDriveDownloadUrl(fileId)).toContain(`id=${fileId}`);
    expect(googleDriveDownloadUrl(fileId, "0-example_key")).toContain("resourcekey=0-example_key");
    expect(validateSourceUrl(`https://drive.google.com/file/d/${fileId}/view`).hostname).toBe("drive.google.com");
    expect(validateSourceUrl("https://open.spotify.com/episode/abc123").hostname).toBe("open.spotify.com");
  });

  it("explains that a Meet room URL is not a recording", () => {
    expect(() => validateSourceUrl("https://meet.google.com/abc-defg-hij"))
      .toThrow("Google Drive-link");
  });
});
