import { similarity } from "../lib/format.js";
import { safeFetch } from "../lib/network.js";
import type { Episode } from "../types.js";
import {
  isFathomHost,
  resolveFathomRecording,
  validateFathomUrl,
} from "./fathom.js";
import {
  isYouTubeHost,
  resolveYouTubeVideo,
  validateYouTubeUrl,
} from "./youtube.js";

export { validateYouTubeUrl, youtubeVideoId } from "./youtube.js";

interface SpotifyEmbed {
  title?: string;
  thumbnail_url?: string;
}
interface DriveMetadata {
  title: string;
  imageUrl?: string;
  mimeType?: string;
}
interface ItunesResult {
  trackName?: string;
  collectionName?: string;
  episodeUrl?: string;
  feedUrl?: string;
  artworkUrl600?: string;
  artworkUrl100?: string;
  description?: string;
  shortDescription?: string;
  releaseDate?: string;
  trackTimeMillis?: number;
}

const DRIVE_HOSTS = new Set(["drive.google.com", "www.drive.google.com"]);
const MEDIA_EXTENSION =
  /\.(?:aac|flac|m4a|m4v|mov|mp3|mp4|mpeg|mpg|ogg|opus|wav|webm)$/i;

export function validateSpotifyUrl(value: string): URL {
  const url = new URL(value);
  const host = url.hostname.toLowerCase();
  if (
    host !== "open.spotify.com" &&
    host !== "spotify.com" &&
    host !== "www.spotify.com"
  ) {
    throw new Error("Plak een publieke open.spotify.com-link.");
  }
  if (!/^\/(episode|show)\/[A-Za-z0-9]+/.test(url.pathname)) {
    throw new Error(
      "Gebruik een Spotify-link naar een aflevering of podcastshow.",
    );
  }
  url.search = "";
  return url;
}

export function googleDriveFileId(value: string): string {
  const url = new URL(value);
  if (!DRIVE_HOSTS.has(url.hostname.toLowerCase())) {
    throw new Error("Plak een publieke Google Drive-link naar de Meet-opname.");
  }
  const pathMatch = url.pathname.match(/^\/file\/d\/([A-Za-z0-9_-]{10,})/);
  const fileId =
    pathMatch?.[1] ??
    (url.pathname === "/open" || url.pathname === "/uc"
      ? url.searchParams.get("id")
      : undefined);
  if (!fileId || !/^[A-Za-z0-9_-]{10,}$/.test(fileId)) {
    throw new Error(
      "Gebruik een Google Drive-link naar één opnamebestand, niet naar een map of Meet-ruimte.",
    );
  }
  return fileId;
}

export function validateGoogleDriveUrl(value: string): URL {
  const fileId = googleDriveFileId(value);
  const input = new URL(value);
  const normalized = new URL(`https://drive.google.com/file/d/${fileId}/view`);
  const resourceKey = input.searchParams.get("resourcekey");
  if (resourceKey && /^[A-Za-z0-9_-]+$/.test(resourceKey)) {
    normalized.searchParams.set("resourcekey", resourceKey);
  }
  return normalized;
}

export function validateSourceUrl(value: string): URL {
  const url = new URL(value);
  const host = url.hostname.toLowerCase();
  if (isFathomHost(host)) {
    return validateFathomUrl(value);
  }
  if (DRIVE_HOSTS.has(host)) {
    return validateGoogleDriveUrl(value);
  }
  if (host === "meet.google.com") {
    throw new Error(
      "Plak de Google Drive-link naar de opname, niet de link naar de Meet-ruimte.",
    );
  }
  if (
    host === "open.spotify.com" ||
    host === "spotify.com" ||
    host === "www.spotify.com"
  ) {
    return validateSpotifyUrl(value);
  }
  if (isYouTubeHost(host)) {
    return validateYouTubeUrl(value);
  }
  throw new Error("error.sourceUnsupported");
}

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_match, code: string) =>
      String.fromCodePoint(Number(code)),
    );
}

function metaContent(html: string, property: string): string | undefined {
  for (const tag of html.match(/<meta\s+[^>]*>/gi) ?? []) {
    const propertyMatch = tag.match(/\bproperty\s*=\s*(["'])(.*?)\1/i);
    if (propertyMatch?.[2]?.toLowerCase() !== property.toLowerCase()) {
      continue;
    }
    const contentMatch = tag.match(/\bcontent\s*=\s*(["'])(.*?)\1/i);
    if (contentMatch?.[2]) {
      return decodeHtml(contentMatch[2]).trim();
    }
  }
  return undefined;
}

export function parseGoogleDriveMetadata(html: string): DriveMetadata {
  const title = metaContent(html, "og:title");
  if (!title) {
    throw new Error(
      "Google Drive gaf geen bestandsgegevens terug. Controleer of iedereen met de link toegang heeft.",
    );
  }
  const mimeType = html.match(/"docs-dm"\s*:\s*"([^"]+)"/i)?.[1];
  const supportedMimeType = Boolean(
    mimeType &&
      (mimeType.toLowerCase().startsWith("audio/") ||
        mimeType.toLowerCase().startsWith("video/")),
  );
  if (!MEDIA_EXTENSION.test(title) && !supportedMimeType) {
    throw new Error(
      "De Google Drive-link verwijst niet naar een ondersteund audio- of videobestand.",
    );
  }
  return { title, imageUrl: metaContent(html, "og:image"), mimeType };
}

export function googleDriveDownloadUrl(
  fileId: string,
  resourceKey?: string,
): string {
  const params = new URLSearchParams({
    id: fileId,
    export: "download",
    authuser: "0",
    confirm: "t",
  });
  if (resourceKey) {
    params.set("resourcekey", resourceKey);
  }
  return `https://drive.usercontent.google.com/download?${params}`;
}

async function getSpotifyMetadata(url: string): Promise<SpotifyEmbed> {
  const endpoint = `https://open.spotify.com/oembed?url=${encodeURIComponent(url)}`;
  const response = await safeFetch(endpoint, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error("Spotify kon deze publieke link niet lezen.");
  }
  return response.json() as Promise<SpotifyEmbed>;
}

async function searchItunes(
  term: string,
  entity: "podcastEpisode" | "podcast",
): Promise<ItunesResult[]> {
  const params = new URLSearchParams({
    term,
    media: "podcast",
    entity,
    limit: "50",
    country: "NL",
  });
  const response = await safeFetch(
    `https://itunes.apple.com/search?${params}`,
    { headers: { Accept: "application/json" } },
  );
  if (!response.ok) {
    throw new Error("De openbare podcastindex is tijdelijk niet bereikbaar.");
  }
  const body = (await response.json()) as { results?: ItunesResult[] };
  return body.results ?? [];
}

export function selectBestEpisode(
  query: string,
  results: ItunesResult[],
): ItunesResult | undefined {
  return results
    .filter((item) => Boolean(item.episodeUrl && item.trackName))
    .map((item) => ({ item, score: similarity(query, item.trackName ?? "") }))
    .sort((a, b) => b.score - a.score)[0]?.item;
}

export async function resolveSpotifyEpisode(value: string): Promise<Episode> {
  const spotifyUrl = validateSpotifyUrl(value).toString();
  const type = new URL(spotifyUrl).pathname.split("/")[1];
  if (type === "show") {
    throw new Error(
      "Kies een specifieke Spotify-aflevering; een show bevat meerdere mogelijke afleveringen.",
    );
  }

  const spotify = await getSpotifyMetadata(spotifyUrl);
  if (!spotify.title) {
    throw new Error("Spotify gaf geen titel voor deze aflevering terug.");
  }

  const candidates = await searchItunes(spotify.title, "podcastEpisode");
  const match = selectBestEpisode(spotify.title, candidates);
  const score = match ? similarity(spotify.title, match.trackName ?? "") : 0;
  if (!match?.episodeUrl || score < 0.34) {
    throw new Error(
      "Deze publieke Spotify-aflevering kon niet met voldoende zekerheid aan een openbare podcastbron worden gekoppeld. Controleer of de aflevering ook via RSS/Apple Podcasts beschikbaar is.",
    );
  }

  return {
    sourceType: "spotify",
    sourceUrl: spotifyUrl,
    sourceName: match.collectionName ?? "Onbekende podcast",
    spotifyUrl,
    title: match.trackName ?? spotify.title,
    podcast: match.collectionName ?? "Onbekende podcast",
    description: match.description ?? match.shortDescription,
    imageUrl:
      match.artworkUrl600 ?? match.artworkUrl100 ?? spotify.thumbnail_url,
    mediaUrl: match.episodeUrl,
    audioUrl: match.episodeUrl,
    durationSeconds: match.trackTimeMillis
      ? Math.round(match.trackTimeMillis / 1000)
      : undefined,
    publishedAt: match.releaseDate,
  };
}

export async function resolveGoogleDriveRecording(
  value: string,
): Promise<Episode> {
  const sourceUrl = validateGoogleDriveUrl(value).toString();
  const response = await safeFetch(sourceUrl, {
    headers: { Accept: "text/html" },
  });
  if (!response.ok) {
    throw new Error(
      response.status === 401 || response.status === 403
        ? "Deze Google Meet-opname is niet openbaar. Kies in Drive voor ‘Iedereen met de link’."
        : `Google Drive kon deze opname niet openen (${response.status}).`,
    );
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("text/html")) {
    throw new Error("Google Drive gaf geen geldige opnamepagina terug.");
  }
  const metadata = parseGoogleDriveMetadata(await response.text());
  const fileId = googleDriveFileId(sourceUrl);
  const resourceKey =
    new URL(sourceUrl).searchParams.get("resourcekey") ?? undefined;
  return {
    sourceType: "google-drive",
    sourceUrl,
    sourceName: "Google Meet-opname",
    title: metadata.title.replace(MEDIA_EXTENSION, ""),
    imageUrl: metadata.imageUrl,
    mediaUrl: googleDriveDownloadUrl(fileId, resourceKey),
  };
}

export async function resolveSource(
  value: string,
  signal?: AbortSignal,
): Promise<Episode> {
  const url = validateSourceUrl(value);
  const host = url.hostname.toLowerCase();
  if (isFathomHost(host)) {
    return resolveFathomRecording(url.toString(), signal);
  }
  if (DRIVE_HOSTS.has(host)) {
    return resolveGoogleDriveRecording(url.toString());
  }
  if (isYouTubeHost(host)) {
    return resolveYouTubeVideo(url.toString(), signal);
  }
  return resolveSpotifyEpisode(url.toString());
}
