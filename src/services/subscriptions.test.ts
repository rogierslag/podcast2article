import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SubscriptionStore, backfillEpisodes } from "./subscriptions.js";
import type { PodcastFeed } from "../types.js";

const options = { language: "nl", articleLength: "standard" } as const;
function feed(count: number): PodcastFeed {
  return {
    url: "https://example.com/feed",
    title: "Wetenschap vandaag",
    episodes: Array.from({ length: count }, (_, index) => ({
      key: `episode-${count - index}`,
      episode: {
        sourceType: "rss",
        sourceUrl: `https://example.com/${count - index}`,
        mediaUrl: `https://example.com/${count - index}.mp3`,
        sourceName: "Wetenschap vandaag",
        title: `Episode ${count - index}`,
      },
    })),
  };
}
let root: string;
let store: SubscriptionStore;
const fetchFeed = vi.fn();
const enqueue = vi.fn();
const outstanding = vi.fn();
let enabled = true;
function createStore() {
  return new SubscriptionStore({
    directory: (username) => {
      if (!/^[a-z][a-z0-9_-]{1,31}$/.test(username)) {
        throw new Error("Invalid username");
      }
      return path.join(root, username);
    },
    fetchFeed,
    enqueue,
    outstanding,
    canProcess: () => enabled,
  });
}
beforeEach(async () => {
  vi.resetAllMocks();
  enabled = true;
  outstanding.mockReturnValue(0);
  root = await mkdtemp(path.join(tmpdir(), "p2a-subscriptions-test-"));
  fetchFeed.mockResolvedValue(feed(12));
  enqueue.mockImplementation(async (_username, item) => ({ id: item.key }));
  store = createStore();
  await store.load(["alice", "bob"]);
});
afterEach(async () => {
  await store.stop();
  await rm(root, { recursive: true, force: true });
});
describe("podcast subscriptions", () => {
  it("lists unscheduled episodes since following without unpausing or starting work", async () => {
    const subscription = await store.follow("alice", feed(2), "none", options);
    await store.pause("alice", subscription.id, true);
    const current = feed(4);
    const latest = current.episodes[0];
    if (!latest) {
      throw new Error("Missing fixture episode");
    }
    current.episodes.push({
      key: "old",
      episode: { ...latest.episode, publishedAt: "2020-01-01T00:00:00Z" },
    });
    fetchFeed.mockResolvedValue(current);

    const available = await store.availableEpisodes("alice", subscription.id);

    expect(available.episodes.map((episode) => episode.key)).toEqual([
      "episode-3",
      "episode-4",
    ]);
    expect(enqueue).not.toHaveBeenCalled();
    expect(store.list("alice")[0]?.paused).toBe(true);
    expect(store.list("alice")[0]?.pending).toEqual([]);
    await expect(
      store.availableEpisodes("bob", subscription.id),
    ).rejects.toThrow("series.errorNotFound");
  });
  it("keeps saved selections accessible in a feed outage and schedules only the reviewed episode", async () => {
    const subscription = await store.follow("alice", feed(3), "three", options);
    await store.pause("alice", subscription.id, true);
    fetchFeed.mockRejectedValue(new Error("Feed offline"));

    const available = await store.availableEpisodes("alice", subscription.id);
    await store.scheduleEpisode("alice", subscription.id, "episode-2", {
      language: "en",
      articleLength: "compact",
    });

    expect(available.feedAvailable).toBe(false);
    expect(available.episodes).toHaveLength(3);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0]?.[1].key).toBe("episode-2");
    expect(enqueue.mock.calls[0]?.[2]).toEqual({
      language: "en",
      articleLength: "compact",
    });
    const restarted = createStore();
    await restarted.load(["alice"]);
    expect(
      restarted.list("alice")[0]?.pending.map((episode) => episode.key),
    ).toEqual(["episode-3", "episode-1"]);
    expect(restarted.list("alice")[0]?.seen).toContain("episode-2");
    expect(restarted.list("alice")[0]?.paused).toBe(true);
    await restarted.stop();
  });
  it("rejects episode scheduling beyond capacity, unavailable keys and disabled processing", async () => {
    const subscription = await store.follow("alice", feed(3), "three", options);
    outstanding.mockReturnValue(8);
    await expect(
      store.scheduleEpisode("alice", subscription.id, "episode-2", options),
    ).rejects.toThrow("series.errorLimit");
    outstanding.mockReturnValue(0);
    await expect(
      store.scheduleEpisode("alice", subscription.id, "unknown", options),
    ).rejects.toThrow("series.errorEpisodeUnavailable");
    enabled = false;
    await expect(
      store.scheduleEpisode("alice", subscription.id, "episode-2", options),
    ).rejects.toThrow("error.creationUnavailable");

    expect(enqueue).not.toHaveBeenCalled();
    expect(store.list("alice")[0]?.pending).toHaveLength(3);
  });
  it("persists series artwork and refreshes legacy subscriptions on a feed check", async () => {
    const original = { ...feed(1), imageUrl: "https://example.com/cover.jpg" };
    await store.follow("alice", original, "none", options);
    await store.follow("bob", feed(1), "none", options);
    const restarted = createStore();
    await restarted.load(["alice", "bob"]);

    expect(restarted.list("alice")[0]?.imageUrl).toBe(original.imageUrl);
    fetchFeed.mockResolvedValue({
      ...feed(1),
      imageUrl: "https://example.com/new.jpg",
    });
    await restarted.check("bob");

    expect(restarted.list("bob")[0]?.imageUrl).toBe(
      "https://example.com/new.jpg",
    );
    await restarted.stop();
  });
  it.each([
    ["none", 0],
    ["three", 3],
  ] as const)("selects %s backlog explicitly", (choice, expected) => {
    expect(backfillEpisodes(feed(12), choice)).toHaveLength(expected);
  });
  it("queues the selected history and only unseen episodes on later checks", async () => {
    await store.follow("alice", feed(12), "three", options);

    await store.check("alice");
    await store.check("alice");
    fetchFeed.mockResolvedValue(feed(13));
    await store.check("alice");

    expect(enqueue).toHaveBeenCalledTimes(4);
    expect(enqueue.mock.calls.at(-1)?.[1].key).toBe("episode-13");
    expect(store.list("alice")[0]?.pending).toHaveLength(0);
    expect(store.list("alice")[0]?.seen).toHaveLength(13);
  });
  it("persists selections and seen state across restarts", async () => {
    await store.follow("alice", feed(12), "three", options);
    const restarted = createStore();
    await restarted.load(["alice"]);

    await restarted.check("alice");
    await restarted.check("alice");

    expect(enqueue).toHaveBeenCalledTimes(3);
    expect(restarted.list("alice")[0]?.title).toBe("Wetenschap vandaag");
    await restarted.stop();
  });
  it("pauses polling, catches up after resume and prevents cross-user mutations", async () => {
    const subscription = await store.follow("alice", feed(12), "none", options);
    await store.pause("alice", subscription.id, true);
    fetchFeed.mockResolvedValue(feed(13));

    await store.check("alice");
    expect(fetchFeed).not.toHaveBeenCalled();
    await expect(store.pause("bob", subscription.id, false)).rejects.toThrow(
      "series.errorNotFound",
    );
    expect(store.list("bob")).toEqual([]);
    await store.pause("alice", subscription.id, false);
    await store.check("alice");

    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0]?.[0]).toBe("alice");
  });
  it("serializes concurrent follows and checks", async () => {
    const follows = await Promise.allSettled([
      store.follow("alice", feed(12), "three", options),
      store.follow("alice", feed(12), "three", options),
    ]);

    await Promise.all([store.check("alice"), store.check("alice")]);

    expect(follows.map((item) => item.status).sort()).toEqual([
      "fulfilled",
      "rejected",
    ]);
    expect(enqueue).toHaveBeenCalledTimes(3);
  });
  it("retains pending history without an API key and recovers when processing is enabled", async () => {
    await store.follow("alice", feed(12), "three", options);
    enabled = false;

    await store.check("alice");
    expect(enqueue).not.toHaveBeenCalled();
    expect(store.list("alice")[0]?.error).toBe("error.creationUnavailable");
    enabled = true;
    outstanding.mockReturnValue(0);
    await store.check("alice");

    expect(enqueue).toHaveBeenCalledTimes(3);
    expect(store.list("alice")[0]?.error).toBeUndefined();
  });
  it("keeps pending episodes on enqueue failure and records recoverable feed outages", async () => {
    await store.follow("alice", feed(12), "three", options);
    enqueue.mockRejectedValueOnce(new Error("Disk full"));

    await store.check("alice");
    expect(store.list("alice")[0]?.pending).toHaveLength(3);
    expect(store.list("alice")[0]?.error).toBe("series.errorCheck");
    fetchFeed.mockRejectedValueOnce(new Error("Offline"));
    await store.check("alice");
    expect(store.list("alice")[0]?.pending).toHaveLength(0);
    expect(store.list("alice")[0]?.error).toBe("series.errorCheck");
    await store.check("alice");

    expect(enqueue).toHaveBeenCalledTimes(4);
    expect(store.list("alice")[0]?.error).toBeUndefined();
  });
  it("rejects invalid usernames before accessing storage", async () => {
    await expect(
      store.follow("../alice", feed(1), "three", options),
    ).rejects.toThrow("Invalid username");
  });
});

describe("subscription limits", () => {
  it("uses saved pending episodes to recognize new undated entries while limit-paused", async () => {
    await store.follow("alice", feed(1), "none", options);
    outstanding.mockReturnValue(8);
    fetchFeed.mockResolvedValue(feed(3));
    await store.check("alice");
    const shortenedFeed = feed(4);
    shortenedFeed.episodes = shortenedFeed.episodes.slice(0, 2);
    fetchFeed.mockResolvedValue(shortenedFeed);

    await store.check("alice");
    await store.check("alice");

    expect(enqueue).not.toHaveBeenCalled();
    expect(
      store.list("alice")[0]?.pending.map((episode) => episode.key),
    ).toEqual(["episode-2", "episode-3", "episode-4"]);
    expect(store.list("alice")[0]?.pauseReason).toBe("limit");
  });
  it.each(["dated", "undated"])(
    "resumes ten missed %s episodes oldest first and preserves the remainder across restart and feed removal",
    async (dates) => {
      function missedFeed(count: number): PodcastFeed {
        const result = feed(count);
        if (dates === "dated") {
          for (const [index, episode] of result.episodes.entries()) {
            episode.episode.publishedAt = new Date(
              Date.UTC(2100, 0, count - index),
            ).toISOString();
          }
        }
        return result;
      }
      const read = new Set<string>();
      outstanding.mockImplementation(
        (_username, ids: string[]) => ids.filter((id) => !read.has(id)).length,
      );
      await store.follow("alice", feed(1), "none", options);
      fetchFeed.mockResolvedValue(missedFeed(9));
      await store.check("alice");
      expect(store.list("alice")[0]?.pauseReason).toBe("limit");

      fetchFeed.mockResolvedValue(missedFeed(19));
      await store.check("alice");
      await store.check("alice");
      expect(enqueue).toHaveBeenCalledTimes(8);
      expect(store.list("alice")[0]?.pending).toHaveLength(10);
      expect(store.list("alice")[0]?.checkedAt).toBeDefined();
      fetchFeed.mockRejectedValueOnce(new Error("Feed offline"));
      await store.check("alice");
      expect(store.list("alice")[0]?.pending).toHaveLength(10);
      expect(store.list("alice")[0]?.pauseReason).toBe("limit");
      for (let episode = 2; episode <= 9; episode += 1) {
        read.add(`episode-${episode}`);
      }
      enqueue.mockClear();
      await store.check("alice");

      expect(enqueue.mock.calls.map((call) => call[1].key)).toEqual([
        "episode-10",
        "episode-11",
        "episode-12",
        "episode-13",
        "episode-14",
        "episode-15",
        "episode-16",
        "episode-17",
      ]);
      expect(
        store.list("alice")[0]?.pending.map((episode) => episode.key),
      ).toEqual(["episode-18", "episode-19"]);
      expect(store.list("alice")[0]?.pauseReason).toBe("limit");

      const restarted = createStore();
      await restarted.load(["alice"]);
      // The saved backlog remains available even when the publisher removes it from RSS.
      const shortenedFeed = missedFeed(20);
      shortenedFeed.episodes = shortenedFeed.episodes.slice(0, 1);
      shortenedFeed.episodes.push(...feed(1).episodes);
      fetchFeed.mockResolvedValue(shortenedFeed);
      for (let episode = 10; episode <= 17; episode += 1) {
        read.add(`episode-${episode}`);
      }
      await restarted.check("alice");

      expect(enqueue.mock.calls.map((call) => call[1].key)).toEqual([
        "episode-10",
        "episode-11",
        "episode-12",
        "episode-13",
        "episode-14",
        "episode-15",
        "episode-16",
        "episode-17",
        "episode-18",
        "episode-19",
        "episode-20",
      ]);
      expect(restarted.list("alice")[0]?.pending).toEqual([]);
      expect(restarted.list("alice")[0]?.paused).toBe(false);
      await restarted.stop();
    },
  );
  it("automatically fills freed capacity after a limit pause without exceeding eight", async () => {
    const read = new Set<string>();
    outstanding.mockImplementation(
      (_username, ids: string[]) => ids.filter((id) => !read.has(id)).length,
    );
    const subscription = await store.follow(
      "alice",
      feed(12),
      "three",
      options,
    );
    await store.check("alice");
    fetchFeed.mockResolvedValue(feed(19));

    await Promise.all([store.check("alice"), store.check("alice")]);

    expect(enqueue).toHaveBeenCalledTimes(8);
    expect(store.list("alice")[0]).toMatchObject({
      paused: true,
      pauseReason: "limit",
    });
    await expect(store.pause("alice", subscription.id, false)).rejects.toThrow(
      "series.errorLimit",
    );
    read.add("episode-12");
    await Promise.all([store.check("alice"), store.check("alice")]);
    expect(enqueue).toHaveBeenCalledTimes(9);
    const restarted = createStore();
    await restarted.load(["alice"]);
    expect(restarted.list("alice")[0]?.pauseReason).toBe("limit");
    read.add("episode-11");
    read.add("episode-10");

    await restarted.check("alice");

    expect(enqueue).toHaveBeenCalledTimes(10);
    expect(restarted.list("alice")[0]?.paused).toBe(false);
    expect(restarted.list("alice")[0]?.pauseReason).toBeUndefined();
    const persisted = createStore();
    await persisted.load(["alice"]);
    expect(persisted.list("alice")[0]?.paused).toBe(false);
    await persisted.stop();
    await restarted.stop();
  });
  it("keeps a manual pause when catch-up reaches the limit and capacity later frees", async () => {
    const subscription = await store.follow("alice", feed(12), "none", options);
    await store.pause("alice", subscription.id, true);
    outstanding.mockImplementation(
      (_username, ids: string[]) => 7 + ids.length,
    );

    await store.backfill("alice", subscription.id);

    expect(store.list("alice")[0]?.paused).toBe(true);
    expect(store.list("alice")[0]?.pauseReason).toBeUndefined();
    outstanding.mockReturnValue(0);
    fetchFeed.mockClear();
    await store.check("alice");

    expect(fetchFeed).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(store.list("alice")[0]?.paused).toBe(true);
  });
  it("resumes only the account with capacity and retains pending work when processing is unavailable", async () => {
    await store.follow("alice", feed(12), "three", options);
    await store.follow("bob", feed(12), "three", options);
    outstanding.mockReturnValue(8);
    await store.check("alice");
    await store.check("bob");
    outstanding.mockImplementation((username: string) =>
      username === "alice" ? 0 : 8,
    );
    enabled = false;

    await store.check("alice");
    await store.check("bob");

    expect(enqueue).not.toHaveBeenCalled();
    expect(store.list("alice")[0]).toMatchObject({
      paused: false,
      error: "error.creationUnavailable",
    });
    expect(store.list("alice")[0]?.pending).toHaveLength(3);
    expect(store.list("bob")[0]).toMatchObject({
      paused: true,
      pauseReason: "limit",
    });
    enabled = true;
    await store.check("alice");

    expect(enqueue).toHaveBeenCalledTimes(3);
    expect(enqueue.mock.calls.every((call) => call[0] === "alice")).toBe(true);
    expect(store.list("alice")[0]?.error).toBeUndefined();
  });
  it("offers only the latest three, never successive older batches", async () => {
    const subscription = await store.follow("alice", feed(12), "none", options);
    await store.check("alice");
    expect(enqueue).not.toHaveBeenCalled();

    const attempts = await Promise.allSettled([
      store.backfill("alice", subscription.id),
      store.backfill("alice", subscription.id),
    ]);

    expect(attempts.map((attempt) => attempt.status)).toEqual([
      "fulfilled",
      "rejected",
    ]);
    expect(enqueue.mock.calls.map((call) => call[1].key)).toEqual([
      "episode-12",
      "episode-11",
      "episode-10",
    ]);
    await expect(store.backfill("alice", subscription.id)).rejects.toThrow(
      "series.errorNoHistory",
    );
    await expect(store.backfill("bob", subscription.id)).rejects.toThrow(
      "series.errorNotFound",
    );
  });
  it("respects remaining capacity and manual pause for the latest-three offer", async () => {
    const subscription = await store.follow("alice", feed(12), "none", options);
    await store.pause("alice", subscription.id, true);
    outstanding.mockReturnValue(7);

    expect(await store.backfill("alice", subscription.id)).toBe(1);
    expect(store.list("alice")[0]?.paused).toBe(true);
    outstanding.mockReturnValue(8);
    await expect(store.backfill("alice", subscription.id)).rejects.toThrow(
      "series.errorLimit",
    );
  });
  it("stops offering skipped episodes once they leave the latest three", async () => {
    const subscription = await store.follow("alice", feed(12), "none", options);
    fetchFeed.mockResolvedValue(feed(15));

    await expect(store.backfill("alice", subscription.id)).rejects.toThrow(
      "series.errorNoHistory",
    );
    await store.check("alice");

    expect(store.list("alice")[0]?.archiveKeys).toEqual([]);
    expect(enqueue.mock.calls.map((call) => call[1].key)).toEqual([
      "episode-13",
      "episode-14",
      "episode-15",
    ]);
  });
  it("does not download older entries newly exposed by an expanded feed", async () => {
    await store.follow("alice", feed(3), "none", options);
    const expanded = feed(4);
    expanded.episodes.push({
      key: "old",
      episode: {
        sourceType: "rss",
        sourceUrl: "https://example.com/old",
        mediaUrl: "https://example.com/old.mp3",
        title: "Old episode",
        sourceName: "Wetenschap vandaag",
        publishedAt: "2020-01-01T00:00:00Z",
      },
    });
    expanded.episodes.push({
      key: "undated-old",
      episode: {
        sourceType: "rss",
        sourceUrl: "https://example.com/old",
        mediaUrl: "https://example.com/old.mp3",
        title: "Old episode",
        sourceName: "Wetenschap vandaag",
      },
    });
    fetchFeed.mockResolvedValue(expanded);

    await store.check("alice");

    expect(enqueue.mock.calls.map((call) => call[1].key)).toEqual([
      "episode-4",
    ]);
  });
});
