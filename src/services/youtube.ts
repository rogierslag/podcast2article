import { rm, stat } from "node:fs/promises";
import { youtubeDl } from "youtube-dl-exec";
import type { Episode } from "../types.js";

const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtube-nocookie.com",
  "www.youtube-nocookie.com",
  "youtu.be",
]);
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

export interface YouTubeMetadata {
  id?: string;
  title?: string;
  description?: string;
  channel?: string;
  uploader?: string;
  duration?: number;
  thumbnail?: string;
  upload_date?: string;
  availability?: string;
  live_status?: string;
  is_live?: boolean;
}

export function isYouTubeHost(hostname: string): boolean {
  return YOUTUBE_HOSTS.has(hostname.toLowerCase());
}

export function youtubeVideoId(value: string): string {
  const url = new URL(value);
  const host = url.hostname.toLowerCase();
  if (!["http:", "https:"].includes(url.protocol) || !isYouTubeHost(host)) {
    throw new Error("Plak een publieke YouTube-videolink.");
  }

  let id: string | null | undefined;
  if (host === "youtu.be") {
    id = url.pathname.split("/").filter(Boolean)[0];
  } else if (url.pathname === "/watch") {
    id = url.searchParams.get("v");
  } else {
    id = url.pathname.match(/^\/(?:shorts|live|embed)\/([A-Za-z0-9_-]{11})(?:\/|$)/)?.[1];
  }

  if (!id || !VIDEO_ID.test(id)) {
    throw new Error("Gebruik een YouTube-link naar één video, niet naar een kanaal, zoekopdracht of afspeellijst.");
  }
  return id;
}

export function validateYouTubeUrl(value: string): URL {
  return new URL(`https://www.youtube.com/watch?v=${youtubeVideoId(value)}`);
}

function publishedAt(uploadDate?: string): string | undefined {
  if (!uploadDate || !/^\d{8}$/.test(uploadDate)) return undefined;
  return `${uploadDate.slice(0, 4)}-${uploadDate.slice(4, 6)}-${uploadDate.slice(6, 8)}`;
}

export function youtubeEpisodeFromMetadata(sourceUrl: string, metadata: YouTubeMetadata): Episode {
  if (!metadata.title) throw new Error("YouTube gaf geen titel voor deze video terug.");
  if (metadata.availability && !["public", "unlisted"].includes(metadata.availability)) {
    throw new Error("Deze YouTube-video is niet openbaar beschikbaar.");
  }
  if (metadata.is_live || metadata.live_status === "is_live" || metadata.live_status === "is_upcoming") {
    throw new Error("Live en geplande YouTube-streams worden niet ondersteund. Gebruik de opname nadat de stream is afgelopen.");
  }

  const duration = metadata.duration;
  return {
    sourceType: "youtube",
    sourceUrl,
    sourceName: metadata.channel ?? metadata.uploader ?? "YouTube",
    title: metadata.title,
    description: metadata.description,
    imageUrl: metadata.thumbnail,
    mediaUrl: sourceUrl,
    durationSeconds: typeof duration === "number" && Number.isFinite(duration) && duration > 0
      ? Math.round(duration)
      : undefined,
    publishedAt: publishedAt(metadata.upload_date),
  };
}

function errorDetails(error: unknown): string {
  if (!error || typeof error !== "object") return String(error);
  const candidate = error as { stderr?: unknown; message?: unknown };
  return String(candidate.stderr ?? candidate.message ?? error);
}

function youtubeFailure(error: unknown, action: "lezen" | "downloaden"): Error {
  const details = errorDetails(error).toLowerCase();
  if (details.includes("private video") || details.includes("members-only")) {
    return new Error("Deze YouTube-video is niet openbaar beschikbaar.");
  }
  if (details.includes("sign in") || details.includes("login required") || details.includes("age-restricted")) {
    return new Error("YouTube vereist aanmelding voor deze video; alleen publiek toegankelijke video's worden ondersteund.");
  }
  if (details.includes("live event will begin") || details.includes("premieres in")) {
    return new Error("Geplande YouTube-streams worden niet ondersteund.");
  }
  if (details.includes("video unavailable") || details.includes("not available")) {
    return new Error("Deze YouTube-video is niet beschikbaar.");
  }
  if (details.includes("larger than max-filesize") || details.includes("file is larger")) {
    return new Error("De YouTube-audio overschrijdt de ingestelde downloadlimiet.");
  }
  return new Error(`YouTube kon deze publieke video niet ${action}.`);
}

export async function resolveYouTubeVideo(value: string, signal?: AbortSignal): Promise<Episode> {
  const sourceUrl = validateYouTubeUrl(value).toString();
  const configuredTimeout = Number(process.env.YOUTUBE_METADATA_TIMEOUT_MS ?? 60_000);
  const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0
    ? Math.floor(configuredTimeout)
    : 60_000;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  try {
    const metadata = await youtubeDl(sourceUrl, {
      dumpSingleJson: true,
      skipDownload: true,
      noPlaylist: true,
      noWarnings: true,
      ignoreConfig: true,
      jsRuntimes: "node",
    }, { signal: requestSignal });
    if (typeof metadata !== "object" || metadata === null) {
      throw new Error("YouTube gaf geen videogegevens terug.");
    }
    return youtubeEpisodeFromMetadata(sourceUrl, metadata as YouTubeMetadata);
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    if (timeoutSignal.aborted) throw new Error("YouTube reageerde niet binnen de ingestelde tijd.");
    if (error instanceof Error && error.message.startsWith("Deze YouTube-")) throw error;
    if (error instanceof Error && error.message.startsWith("Live en geplande")) throw error;
    if (error instanceof Error && error.message.startsWith("YouTube gaf geen titel")) throw error;
    throw youtubeFailure(error, "lezen");
  }
}

export async function downloadYouTubeAudio(
  sourceUrl: string,
  target: string,
  signal?: AbortSignal,
  options: { maxMegabytes?: number; timeoutMs?: number } = {},
): Promise<void> {
  const maxMegabytes = Number.isFinite(options.maxMegabytes) && (options.maxMegabytes ?? 0) > 0
    ? options.maxMegabytes!
    : 500;
  const configuredTimeout = options.timeoutMs ?? Number(process.env.MEDIA_DOWNLOAD_TIMEOUT_MS ?? 900_000);
  const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0
    ? Math.floor(configuredTimeout)
    : 900_000;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

  try {
    await youtubeDl(validateYouTubeUrl(sourceUrl).toString(), {
      format: "bestaudio/best",
      output: target,
      noPlaylist: true,
      noWarnings: true,
      noProgress: true,
      ignoreConfig: true,
      jsRuntimes: "node",
      maxFilesize: `${maxMegabytes}M`,
      noPart: true,
      forceOverwrites: true,
      socketTimeout: Math.max(1, Math.floor(timeoutMs / 1000)),
    }, { signal: requestSignal });

    let size: number;
    try {
      size = (await stat(target)).size;
    } catch {
      throw new Error("De YouTube-audio is niet beschikbaar of overschrijdt de ingestelde downloadlimiet.");
    }
    if (!size) throw new Error("YouTube gaf een leeg audiobestand terug.");
    if (size > maxMegabytes * 1024 * 1024) {
      throw new Error("De YouTube-audio overschrijdt de ingestelde downloadlimiet.");
    }
  } catch (error) {
    await rm(target, { force: true }).catch(() => undefined);
    if (signal?.aborted) throw signal.reason;
    if (timeoutSignal.aborted) throw new Error("Het downloaden van YouTube duurde te lang.");
    if (error instanceof Error && (
      error.message.startsWith("De YouTube-audio") ||
      error.message.startsWith("YouTube gaf een leeg")
    )) throw error;
    throw youtubeFailure(error, "downloaden");
  }
}
