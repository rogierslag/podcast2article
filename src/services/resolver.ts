import { similarity } from "../lib/format.js";
import { safeFetch } from "../lib/network.js";
import type { Episode } from "../types.js";

interface SpotifyEmbed { title?: string; thumbnail_url?: string; }
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

export function validateSpotifyUrl(value: string): URL {
  const url = new URL(value);
  const host = url.hostname.toLowerCase();
  if (host !== "open.spotify.com" && host !== "spotify.com" && host !== "www.spotify.com") {
    throw new Error("Plak een publieke open.spotify.com-link.");
  }
  if (!/^\/(episode|show)\/[A-Za-z0-9]+/.test(url.pathname)) {
    throw new Error("Gebruik een Spotify-link naar een aflevering of podcastshow.");
  }
  url.search = "";
  return url;
}

async function getSpotifyMetadata(url: string): Promise<SpotifyEmbed> {
  const endpoint = `https://open.spotify.com/oembed?url=${encodeURIComponent(url)}`;
  const response = await safeFetch(endpoint, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error("Spotify kon deze publieke link niet lezen.");
  return response.json() as Promise<SpotifyEmbed>;
}

async function searchItunes(term: string, entity: "podcastEpisode" | "podcast"): Promise<ItunesResult[]> {
  const params = new URLSearchParams({ term, media: "podcast", entity, limit: "50", country: "NL" });
  const response = await safeFetch(`https://itunes.apple.com/search?${params}`, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error("De openbare podcastindex is tijdelijk niet bereikbaar.");
  const body = await response.json() as { results?: ItunesResult[] };
  return body.results ?? [];
}

export function selectBestEpisode(query: string, results: ItunesResult[]): ItunesResult | undefined {
  return results
    .filter((item) => Boolean(item.episodeUrl && item.trackName))
    .map((item) => ({ item, score: similarity(query, item.trackName ?? "") }))
    .sort((a, b) => b.score - a.score)[0]?.item;
}

export async function resolveSpotifyEpisode(value: string): Promise<Episode> {
  const spotifyUrl = validateSpotifyUrl(value).toString();
  const type = new URL(spotifyUrl).pathname.split("/")[1];
  if (type === "show") {
    throw new Error("Kies een specifieke Spotify-aflevering; een show bevat meerdere mogelijke afleveringen.");
  }

  const spotify = await getSpotifyMetadata(spotifyUrl);
  if (!spotify.title) throw new Error("Spotify gaf geen titel voor deze aflevering terug.");

  const candidates = await searchItunes(spotify.title, "podcastEpisode");
  const match = selectBestEpisode(spotify.title, candidates);
  const score = match ? similarity(spotify.title, match.trackName ?? "") : 0;
  if (!match?.episodeUrl || score < 0.34) {
    throw new Error(
      "Deze publieke Spotify-aflevering kon niet met voldoende zekerheid aan een openbare podcastbron worden gekoppeld. Controleer of de aflevering ook via RSS/Apple Podcasts beschikbaar is."
    );
  }

  return {
    spotifyUrl,
    title: match.trackName ?? spotify.title,
    podcast: match.collectionName ?? "Onbekende podcast",
    description: match.description ?? match.shortDescription,
    imageUrl: match.artworkUrl600 ?? match.artworkUrl100 ?? spotify.thumbnail_url,
    audioUrl: match.episodeUrl,
    durationSeconds: match.trackTimeMillis ? Math.round(match.trackTimeMillis / 1000) : undefined,
    publishedAt: match.releaseDate,
  };
}
