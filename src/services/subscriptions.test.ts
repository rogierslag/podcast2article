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
  it("pauses at five including processing jobs and resumes only explicitly", async () => {
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
    fetchFeed.mockResolvedValue(feed(16));

    await Promise.all([store.check("alice"), store.check("alice")]);

    expect(enqueue).toHaveBeenCalledTimes(5);
    expect(store.list("alice")[0]).toMatchObject({
      paused: true,
      pauseReason: "limit",
    });
    await expect(store.pause("alice", subscription.id, false)).rejects.toThrow(
      "series.errorLimit",
    );
    read.add("episode-12");
    await store.check("alice");
    expect(enqueue).toHaveBeenCalledTimes(5);
    await store.pause("alice", subscription.id, false);
    await store.check("alice");
    expect(enqueue).toHaveBeenCalledTimes(6);
    const restarted = createStore();
    await restarted.load(["alice"]);
    expect(restarted.list("alice")[0]?.pauseReason).toBe("limit");
    await restarted.stop();
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
    outstanding.mockReturnValue(4);

    expect(await store.backfill("alice", subscription.id)).toBe(1);
    expect(store.list("alice")[0]?.paused).toBe(true);
    outstanding.mockReturnValue(5);
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
      "episode-15",
      "episode-14",
      "episode-13",
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
