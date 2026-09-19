import { createHash } from "node:crypto";
import { decodeHTMLStrict } from "entities";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { z } from "zod";
import { safeFetch } from "../lib/network.js";
import type { PodcastFeed } from "../types.js";
import { validateSpotifyUrl } from "./resolver.js";

const maxFeedBytes = 10 * 1024 * 1024;
const parser = new XMLParser({
  ignoreAttributes: false,
  parseTagValue: false,
  processEntities: true,
  htmlEntities: true,
});

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function text(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }
  return typeof record(value)["#text"] === "string"
    ? String(record(value)["#text"]).trim()
    : "";
}
function list(value: unknown): unknown[] {
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}
function httpUrl(value: string, base: string): string | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const url = new URL(value, base);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    ) {
      return undefined;
    }
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

export function parsePodcastFeed(xml: string, url: string): PodcastFeed {
  // DTDs and custom entities are unnecessary for podcast feeds and permit expansion attacks.
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true) {
    throw new Error("series.errorFeed");
  }
  const parsed: unknown = parser.parse(xml);
  const channel = record(record(record(parsed).rss).channel);
  // RSS display fields often contain HTML entities inside XML or CDATA.
  const title = decodeHTMLStrict(text(channel.title));
  if (!title) {
    throw new Error("series.errorFeed");
  }
  const imageUrl = httpUrl(
    text(record(channel["itunes:image"])["@_href"]) ||
      text(record(channel.image).url),
    url,
  );
  const episodes: PodcastFeed["episodes"] = [];
  const keys = new Set<string>();
  for (const value of list(channel.item)) {
    const item = record(value);
    const enclosure = list(item.enclosure)
      .map(record)
      .find((entry) => {
        const type = text(entry["@_type"]);
        return (
          (!type || type.startsWith("audio/")) &&
          httpUrl(text(entry["@_url"]), url)
        );
      });
    const mediaUrl = enclosure && httpUrl(text(enclosure["@_url"]), url);
    const episodeTitle = decodeHTMLStrict(text(item.title));
    if (!mediaUrl || !episodeTitle) {
      continue;
    }
    const identity = text(item.guid) || mediaUrl;
    const key = createHash("sha256")
      .update(`${url}\n${identity}`)
      .digest("hex");
    if (keys.has(key)) {
      continue;
    }
    keys.add(key);
    const published = Date.parse(text(item.pubDate));
    episodes.push({
      key,
      episode: {
        sourceType: "rss",
        feedUrl: url,
        sourceUrl: httpUrl(text(item.link), url) || mediaUrl,
        sourceName: title,
        title: episodeTitle,
        mediaUrl,
        description: decodeHTMLStrict(text(item.description)) || undefined,
        imageUrl:
          httpUrl(text(record(item["itunes:image"])["@_href"]), url) ||
          imageUrl,
        publishedAt: Number.isFinite(published)
          ? new Date(published).toISOString()
          : undefined,
      },
    });
  }
  if (!episodes.length) {
    throw new Error("series.errorEmpty");
  }
  episodes.sort((left, right) =>
    (right.episode.publishedAt || "").localeCompare(
      left.episode.publishedAt || "",
    ),
  );
  return { url, title, imageUrl, episodes };
}

export async function fetchPodcastFeed(value: string): Promise<PodcastFeed> {
  const url = httpUrl(value, value);
  if (!url) {
    throw new Error("series.errorFeed");
  }
  const response = await safeFetch(url, {
    headers: { Accept: "application/rss+xml, application/xml, text/xml" },
  });
  if (!response.ok || !response.body) {
    throw new Error("series.errorFeed");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { value: chunk, done } = await reader.read();
      if (done) {
        break;
      }
      bytes += chunk.byteLength;
      if (bytes > maxFeedBytes) {
        throw new Error("series.errorFeed");
      }
      chunks.push(chunk);
    }
  } finally {
    await reader.cancel();
  }
  // Keep the supplied URL as identity even when a host redirects its feed.
  const buffer = Buffer.concat(chunks);
  const charset = response.headers
    .get("content-type")
    ?.match(/charset=["']?([^\s;"']+)/i)?.[1];
  const declaration = buffer
    .toString("ascii", 0, 256)
    .match(/^<\?xml[^>]*encoding=["']([^"']+)/i)?.[1];
  const bomEncoding =
    buffer[0] === 0xff && buffer[1] === 0xfe
      ? "utf-16le"
      : buffer[0] === 0xfe && buffer[1] === 0xff
        ? "utf-16be"
        : buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf
          ? "utf-8"
          : undefined;
  let xml: string;
  try {
    xml = new TextDecoder(bomEncoding || charset || declaration || "utf-8", {
      fatal: true,
    }).decode(buffer);
  } catch {
    throw new Error("series.errorFeed");
  }
  return parsePodcastFeed(xml, url);
}

const searchSchema = z.object({
  results: z.array(
    z.object({
      collectionName: z.string().optional(),
      feedUrl: z.string().optional(),
      artistName: z.string().optional(),
      artworkUrl100: z.string().optional(),
    }),
  ),
});

export async function discoverPodcastFeeds(value: string) {
  const input = new URL(value);
  if (
    !["open.spotify.com", "spotify.com", "www.spotify.com"].includes(
      input.hostname,
    )
  ) {
    const url = httpUrl(value, value);
    if (!url) {
      throw new Error("series.errorFeed");
    }
    return [{ title: url, url, author: "" }];
  }
  const url = validateSpotifyUrl(value);
  if (!/^\/show\/[a-zA-Z0-9]+\/?$/.test(url.pathname)) {
    throw new Error("series.errorShow");
  }
  const metadataResponse = await safeFetch(
    `https://open.spotify.com/oembed?url=${encodeURIComponent(url.toString())}`,
  );
  if (!metadataResponse.ok) {
    throw new Error("series.errorDiscovery");
  }
  const metadata = z
    .object({ title: z.string().min(1) })
    .parse(await metadataResponse.json());
  const params = new URLSearchParams({
    term: decodeHTMLStrict(metadata.title),
    media: "podcast",
    entity: "podcast",
    limit: "10",
    country: "NL",
  });
  const response = await safeFetch(`https://itunes.apple.com/search?${params}`);
  if (!response.ok) {
    throw new Error("series.errorDiscovery");
  }
  const results = searchSchema.parse(await response.json()).results;
  const candidates = results.flatMap((item) => {
    const feedUrl = item.feedUrl && httpUrl(item.feedUrl, item.feedUrl);
    return feedUrl && item.collectionName
      ? [
          {
            title: decodeHTMLStrict(item.collectionName),
            url: feedUrl,
            author: decodeHTMLStrict(item.artistName || ""),
            imageUrl: httpUrl(item.artworkUrl100 || "", feedUrl),
          },
        ]
      : [];
  });
  if (!candidates.length) {
    throw new Error("series.errorDiscovery");
  }
  // Matching by title is ambiguous: the reader chooses and previews the actual feed.
  return [
    ...new Map(
      candidates.map((candidate) => [candidate.url, candidate]),
    ).values(),
  ];
}
