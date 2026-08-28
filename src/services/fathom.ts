import { rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { youtubeDl } from "youtube-dl-exec";
import { z } from "zod";
import type { Episode } from "../types.js";

const require = createRequire(import.meta.url);
const ffmpegPath = require("ffmpeg-static") as string | null;
const metadataSchema = z.object({
  title: z.string().trim().min(1),
  duration: z.number().finite().positive().optional().catch(undefined),
  timestamp: z.number().finite().optional().catch(undefined),
  availability: z.string().optional(),
});

export function isFathomHost(hostname: string): boolean {
  return hostname === "fathom.video" || hostname === "www.fathom.video";
}

export function validateFathomUrl(value: string): URL {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !isFathomHost(url.hostname) ||
    url.username ||
    url.password ||
    url.port
  ) {
    throw new Error("error.fathomLinkRequired");
  }
  if (/^\/calls(?:\/|$)/.test(url.pathname)) {
    throw new Error("error.fathomShareRequired");
  }
  const token = url.pathname.match(/^\/share\/([A-Za-z0-9_-]+)\/?$/)?.[1];
  if (!token) {
    throw new Error("error.fathomLinkRequired");
  }
  return new URL(`https://fathom.video/share/${token}`);
}

export function fathomEpisodeFromMetadata(
  sourceUrl: string,
  value: unknown,
): Episode {
  const parsed = metadataSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error("error.fathomMetadataMissing");
  }
  const metadata = parsed.data;
  if (
    metadata.availability &&
    !["public", "unlisted"].includes(metadata.availability)
  ) {
    throw new Error("error.fathomPrivate");
  }
  const startedAt =
    metadata.timestamp === undefined
      ? undefined
      : new Date(metadata.timestamp * 1000);
  return {
    sourceType: "fathom",
    sourceUrl,
    sourceName: "Fathom",
    title: metadata.title,
    // Resolve the signed stream again at download time; do not persist it.
    mediaUrl: sourceUrl,
    durationSeconds:
      metadata.duration === undefined
        ? undefined
        : Math.round(metadata.duration),
    publishedAt:
      startedAt && Number.isFinite(startedAt.getTime())
        ? startedAt.toISOString()
        : undefined,
  };
}

function positiveSetting(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function fathomFailure(error: unknown, fallback: string): Error {
  if (error instanceof Error && error.message.startsWith("error.fathom")) {
    return error;
  }
  const details =
    error && typeof error === "object" && "stderr" in error
      ? String(error.stderr)
      : String(error);
  const message = details.replace(/https?:\/\/\S+/g, "");
  if (/sign.?in|log.?in|private|password|\b403\b|\b401\b/i.test(message)) {
    return new Error("error.fathomPrivate");
  }
  // Never expose downloader stderr: it can contain signed media URLs.
  return new Error(fallback);
}

export async function resolveFathomRecording(
  value: string,
  signal?: AbortSignal,
): Promise<Episode> {
  const sourceUrl = validateFathomUrl(value).toString();
  const timeout = AbortSignal.timeout(60_000);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  requestSignal.throwIfAborted();
  try {
    const metadata = await youtubeDl(
      sourceUrl,
      {
        dumpSingleJson: true,
        skipDownload: true,
        noPlaylist: true,
        noWarnings: true,
        ignoreConfig: true,
        noCacheDir: true,
      },
      { signal: requestSignal },
    );
    return fathomEpisodeFromMetadata(sourceUrl, metadata);
  } catch (error) {
    signal?.throwIfAborted();
    if (timeout.aborted) {
      throw new Error("error.fathomTimeout");
    }
    throw fathomFailure(error, "error.fathomUnreadable");
  }
}

interface FathomDownloadOptions {
  maxMegabytes?: number;
  timeoutMs?: number;
}

export async function downloadFathomRecording(
  value: string,
  target: string,
  signal?: AbortSignal,
  options: FathomDownloadOptions = {},
): Promise<void> {
  const sourceUrl = validateFathomUrl(value).toString();
  const maxMegabytes = positiveSetting(options.maxMegabytes, 1_500);
  const timeoutMs = Math.floor(
    positiveSetting(
      options.timeoutMs ?? process.env.MEDIA_DOWNLOAD_TIMEOUT_MS,
      900_000,
    ),
  );
  const timeout = AbortSignal.timeout(timeoutMs);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    requestSignal.throwIfAborted();
    await youtubeDl(
      sourceUrl,
      {
        format: "bestaudio/best",
        output: target,
        noPlaylist: true,
        noWarnings: true,
        noProgress: true,
        ignoreConfig: true,
        noCacheDir: true,
        noPart: true,
        forceOverwrites: true,
        abortOnUnavailableFragment: true,
        maxFilesize: `${maxMegabytes}M`,
        socketTimeout: Math.max(1, Math.floor(timeoutMs / 1000)),
        ...(ffmpegPath ? { ffmpegLocation: ffmpegPath } : {}),
      },
      { signal: requestSignal },
    );
    const file = await stat(target);
    if (!file.size) {
      throw new Error("error.fathomDownloadEmpty");
    }
    if (file.size > maxMegabytes * 1024 * 1024) {
      throw new Error("error.fathomDownloadLimit");
    }
  } catch (error) {
    await rm(target, { force: true });
    signal?.throwIfAborted();
    if (timeout.aborted) {
      throw new Error("error.fathomTimeout");
    }
    throw fathomFailure(error, "error.fathomDownloadFailed");
  }
}
