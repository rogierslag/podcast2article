import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  downloadFathomRecording,
  fathomEpisodeFromMetadata,
  resolveFathomRecording,
  validateFathomUrl,
} from "./fathom.js";
import { resolveSource, validateSourceUrl } from "./resolver.js";

const downloader = vi.hoisted(() => vi.fn());
vi.mock("youtube-dl-exec", () => ({ youtubeDl: downloader }));
const sourceUrl = "https://fathom.video/share/test-public-recording";

beforeEach(() => {
  downloader.mockReset();
});

describe("Fathom source resolution", () => {
  it("canonicalizes share links without changing their capability token", () => {
    expect(
      validateSourceUrl(
        "http://www.fathom.video/share/AbC_123-x/?tab=summary#t=20",
      ).toString(),
    ).toBe("https://fathom.video/share/AbC_123-x");
  });

  it.each([
    "https://fathom.video/calls/800373080?tab=summary",
    "https://fathom.video/calls/800373080",
  ])("explains how to share an internal call URL: %s", (url) => {
    expect(() => validateSourceUrl(url)).toThrow("error.fathomShareRequired");
  });

  it.each([
    "https://fathom.video/",
    "https://fathom.video/share/",
    "https://fathom.video/share/token/other",
    "https://fathom.video/share/a%2Fb",
    "https://fathom.video.evil.test/share/token",
    "https://evil.test/share/token",
    "ftp://fathom.video/share/token",
    "https://user:password@fathom.video/share/token",
    "https://fathom.video:444/share/token",
  ])("rejects unsupported or unsafe URLs: %s", (url) => {
    expect(() => validateFathomUrl(url)).toThrow("error.fathomLinkRequired");
  });

  it("resolves metadata through the normal source dispatcher without persisting signed streams", async () => {
    downloader.mockResolvedValue({
      title: "Teamgesprek: ruimte voor aandacht",
      duration: 1832.4,
      timestamp: 1787918400,
      url: "https://cdn.example/signed-stream?secret=private",
    });
    const controller = new AbortController();

    const episode = await resolveSource(
      `${sourceUrl}?tab=summary`,
      controller.signal,
    );

    expect(episode).toEqual({
      sourceType: "fathom",
      sourceUrl,
      sourceName: "Fathom",
      title: "Teamgesprek: ruimte voor aandacht",
      mediaUrl: sourceUrl,
      durationSeconds: 1832,
      publishedAt: new Date(1787918400000).toISOString(),
    });
    expect(downloader).toHaveBeenCalledWith(
      sourceUrl,
      expect.objectContaining({
        skipDownload: true,
        ignoreConfig: true,
        noPlaylist: true,
      }),
      { signal: expect.any(AbortSignal) },
    );
  });

  it.each([null, "html", {}, { title: " " }, { title: 42 }])(
    "rejects unusable metadata: %j",
    (metadata) => {
      expect(() => fathomEpisodeFromMetadata(sourceUrl, metadata)).toThrow(
        "error.fathomMetadataMissing",
      );
    },
  );

  it("ignores malformed optional metadata and rejects private recordings", () => {
    expect(
      fathomEpisodeFromMetadata(sourceUrl, {
        title: "Opname",
        duration: -2,
        timestamp: 1e30,
      }),
    ).toMatchObject({ durationSeconds: undefined, publishedAt: undefined });
    expect(() =>
      fathomEpisodeFromMetadata(sourceUrl, {
        title: "Privé",
        availability: "private",
      }),
    ).toThrow("error.fathomPrivate");
  });

  it("provides an actionable access error without leaking downloader output", async () => {
    downloader.mockRejectedValue({
      stderr: "HTTP 403 https://cdn.example/?secret=private",
    });

    await expect(resolveFathomRecording(sourceUrl)).rejects.toThrow(
      "error.fathomPrivate",
    );
  });

  it("keeps unknown extractor failures actionable", async () => {
    downloader.mockRejectedValue({
      stderr: "Missing call data https://cdn.example/?secret=private",
    });

    await expect(resolveFathomRecording(sourceUrl)).rejects.toThrow(
      "error.fathomUnreadable",
    );
  });

  it("does not start a subprocess for an invalid or cancelled source", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));

    await expect(
      resolveFathomRecording(sourceUrl, controller.signal),
    ).rejects.toThrow("cancelled");
    await expect(
      resolveFathomRecording("https://fathom.video/calls/123"),
    ).rejects.toThrow("error.fathomShareRequired");
    expect(downloader).not.toHaveBeenCalled();
  });
});

describe("Fathom recording download", () => {
  let directory: string;
  let target: string;
  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "p2a-fathom-test-"));
    target = path.join(directory, "source.media");
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("downloads the public recording for the existing audio pipeline", async () => {
    downloader.mockImplementation(async () => writeFile(target, "audio"));

    await downloadFathomRecording(sourceUrl, target, undefined, {
      maxMegabytes: 42,
    });

    expect((await stat(target)).size).toBe(5);
    expect(downloader).toHaveBeenCalledWith(
      sourceUrl,
      expect.objectContaining({
        output: target,
        format: "bestaudio/best",
        maxFilesize: "42M",
        ignoreConfig: true,
        abortOnUnavailableFragment: true,
        noPart: true,
      }),
      { signal: expect.any(AbortSignal) },
    );
  });

  it.each([
    ["", 1, "error.fathomDownloadEmpty"],
    ["too much audio", 0.000001, "error.fathomDownloadLimit"],
  ] as const)(
    "removes empty or oversized output",
    async (content, maxMegabytes, error) => {
      downloader.mockImplementation(async () => writeFile(target, content));

      await expect(
        downloadFathomRecording(sourceUrl, target, undefined, { maxMegabytes }),
      ).rejects.toThrow(error);
      await expect(stat(target)).rejects.toThrow();
    },
  );

  it("rejects a download skipped because of its estimated size", async () => {
    downloader.mockResolvedValue("");

    await expect(downloadFathomRecording(sourceUrl, target)).rejects.toThrow(
      "error.fathomDownloadFailed",
    );
  });

  it("removes partial downloads and preserves cancellation", async () => {
    const controller = new AbortController();
    downloader.mockImplementation(async () => {
      await writeFile(target, "partial");
      controller.abort(new Error("cancelled"));
      throw new Error("aborted");
    });

    await expect(
      downloadFathomRecording(sourceUrl, target, controller.signal),
    ).rejects.toThrow("cancelled");
    await expect(stat(target)).rejects.toThrow();
  });

  it("times out stalled downloads and cleans up", async () => {
    downloader.mockImplementation(
      async (_url, _flags, options: { signal: AbortSignal }) => {
        await writeFile(target, "partial");
        await new Promise((_resolve, reject) => {
          options.signal.addEventListener(
            "abort",
            () => reject(options.signal.reason),
            { once: true },
          );
        });
      },
    );

    await expect(
      downloadFathomRecording(sourceUrl, target, undefined, { timeoutMs: 50 }),
    ).rejects.toThrow("error.fathomTimeout");
    await expect(stat(target)).rejects.toThrow();
  });
});
