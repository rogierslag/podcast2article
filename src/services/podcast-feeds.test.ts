import { describe, expect, it, vi, beforeEach } from "vitest";
import { safeFetch } from "../lib/network.js";
import {
  discoverPodcastFeeds,
  fetchPodcastFeed,
  parsePodcastFeed,
} from "./podcast-feeds.js";
vi.mock("../lib/network.js", () => ({ safeFetch: vi.fn() }));
const url = "https://example.com/feed.xml";
const xml = `<rss><channel><title>Science &amp; Society</title><itunes:image href="https://example.com/cover.jpg"/>
<item><guid>old</guid><title>Older episode</title><pubDate>Mon, 01 Jun 2026 10:00:00 GMT</pubDate><enclosure url="https://example.com/old.mp3" type="audio/mpeg"/></item>
<item><guid>new</guid><title><![CDATA[A <thoughtful> conversation]]></title><link>javascript:alert(1)</link><pubDate>Tue, 02 Jun 2026 10:00:00 GMT</pubDate><enclosure url="/new.mp3" type="audio/mpeg"/></item>
<item><guid>new</guid><title>Duplicate</title><enclosure url="https://example.com/new.mp3" type="audio/mpeg"/></item>
<item><title>Not audio</title><enclosure url="https://example.com/movie.mp4" type="video/mp4"/></item>
</channel></rss>`;
beforeEach(() => vi.resetAllMocks());
describe("podcast feed parsing", () => {
  it("reads audio, decodes text, sorts newest first and keeps unique identities", () => {
    const feed = parsePodcastFeed(xml, url);

    expect(feed.title).toBe("Science & Society");
    expect(feed.episodes).toHaveLength(2);
    expect(feed.episodes[0]?.episode).toMatchObject({
      title: "A <thoughtful> conversation",
      sourceType: "rss",
      sourceUrl: "https://example.com/new.mp3",
      imageUrl: "https://example.com/cover.jpg",
    });
  });
  it("keeps GUID identity when an enclosure changes, and isolates different feeds", () => {
    const original = parsePodcastFeed(xml, url).episodes[0]?.key;

    expect(
      parsePodcastFeed(xml.replace("/new.mp3", "/replacement.mp3"), url)
        .episodes[0]?.key,
    ).toBe(original);
    expect(
      parsePodcastFeed(xml, "https://other.example/feed").episodes[0]?.key,
    ).not.toBe(original);
  });
  it.each([
    "<html></html>",
    "<rss>",
    '<!DOCTYPE rss [<!ENTITY secret SYSTEM "file:///etc/passwd">]><rss/>',
  ])("rejects invalid feeds and DTDs: %s", (input) => {
    expect(() => parsePodcastFeed(input, url)).toThrow("series.errorFeed");
  });
  it("rejects empty feeds and non-HTTP enclosures", () => {
    expect(() =>
      parsePodcastFeed(
        "<rss><channel><title>Empty</title></channel></rss>",
        url,
      ),
    ).toThrow("series.errorEmpty");
    expect(() =>
      parsePodcastFeed(
        '<rss><channel><title>Unsafe</title><item><title>Episode</title><enclosure url="file:///secret"/></item></channel></rss>',
        url,
      ),
    ).toThrow("series.errorEmpty");
  });
  it("uses the guarded fetcher and refuses oversized feeds", async () => {
    vi.mocked(safeFetch).mockResolvedValueOnce(new Response(xml));

    expect((await fetchPodcastFeed(url)).episodes).toHaveLength(2);
    expect(safeFetch).toHaveBeenCalledWith(url, expect.any(Object));
    vi.mocked(safeFetch).mockResolvedValueOnce(
      new Response("x".repeat(10 * 1024 * 1024 + 1)),
    );
    await expect(fetchPodcastFeed(url)).rejects.toThrow("series.errorFeed");
  });
  it("propagates private network rejection without another fetch route", async () => {
    vi.mocked(safeFetch).mockRejectedValueOnce(new Error("Private address"));

    await expect(fetchPodcastFeed("http://127.0.0.1/feed")).rejects.toThrow(
      "Private address",
    );
    expect(safeFetch).toHaveBeenCalledTimes(1);
  });
});
describe("Spotify series discovery", () => {
  it("returns candidate feeds for explicit review instead of silently choosing a title match", async () => {
    vi.mocked(safeFetch)
      .mockResolvedValueOnce(Response.json({ title: "Science" }))
      .mockResolvedValueOnce(
        Response.json({
          results: [
            {
              collectionName: "Science",
              feedUrl: url,
              artistName: "Publisher",
            },
            {
              collectionName: "Science",
              feedUrl: url,
              artistName: "Publisher",
            },
            {
              collectionName: "Science Weekly",
              feedUrl: "https://example.org/rss",
            },
            { collectionName: "Unsafe", feedUrl: "javascript:alert(1)" },
          ],
        }),
      );

    const candidates = await discoverPodcastFeeds(
      "https://open.spotify.com/show/abc?si=tracking",
    );

    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toMatchObject({
      title: "Science",
      author: "Publisher",
      url,
    });
  });
  it("rejects individual episodes and unknown shows", async () => {
    await expect(
      discoverPodcastFeeds("https://open.spotify.com/episode/abc"),
    ).rejects.toThrow("series.errorShow");
    vi.mocked(safeFetch)
      .mockResolvedValueOnce(Response.json({ title: "Exclusive" }))
      .mockResolvedValueOnce(Response.json({ results: [] }));
    await expect(
      discoverPodcastFeeds("https://open.spotify.com/show/abc"),
    ).rejects.toThrow("series.errorDiscovery");
  });
});
