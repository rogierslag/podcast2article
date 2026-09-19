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
    ["latest", 1],
    ["ten", 10],
  ] as const)("selects %s backlog explicitly", (choice, expected) => {
    expect(backfillEpisodes(feed(12), choice)).toHaveLength(expected);
  });
  it("queues the selected history and only unseen episodes on later checks", async () => {
    await store.follow("alice", feed(12), "ten", options);

    await store.check("alice");
    await store.check("alice");
    fetchFeed.mockResolvedValue(feed(13));
    await store.check("alice");

    expect(enqueue).toHaveBeenCalledTimes(11);
    expect(enqueue.mock.calls.at(-1)?.[1].key).toBe("episode-13");
    expect(store.list("alice")[0]?.pending).toHaveLength(0);
    expect(store.list("alice")[0]?.seen).toHaveLength(13);
  });
  it("persists selections and seen state across restarts", async () => {
    await store.follow("alice", feed(12), "latest", options);
    const restarted = createStore();
    await restarted.load(["alice"]);

    await restarted.check("alice");
    await restarted.check("alice");

    expect(enqueue).toHaveBeenCalledTimes(1);
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
      store.follow("alice", feed(12), "ten", options),
      store.follow("alice", feed(12), "ten", options),
    ]);

    await Promise.all([store.check("alice"), store.check("alice")]);

    expect(follows.map((item) => item.status).sort()).toEqual([
      "fulfilled",
      "rejected",
    ]);
    expect(enqueue).toHaveBeenCalledTimes(10);
  });
  it("retains pending history without an API key and recovers when processing is enabled", async () => {
    await store.follow("alice", feed(12), "latest", options);
    enabled = false;

    await store.check("alice");
    expect(enqueue).not.toHaveBeenCalled();
    expect(store.list("alice")[0]?.error).toBe("error.creationUnavailable");
    enabled = true;
    outstanding.mockReturnValue(0);
    await store.check("alice");

    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(store.list("alice")[0]?.error).toBeUndefined();
  });
  it("keeps pending episodes on enqueue failure and records recoverable feed outages", async () => {
    await store.follow("alice", feed(12), "latest", options);
    enqueue.mockRejectedValueOnce(new Error("Disk full"));

    await store.check("alice");
    expect(store.list("alice")[0]?.pending).toHaveLength(1);
    expect(store.list("alice")[0]?.error).toBe("series.errorCheck");
    fetchFeed.mockRejectedValueOnce(new Error("Offline"));
    await store.check("alice");
    expect(store.list("alice")[0]?.pending).toHaveLength(0);
    expect(store.list("alice")[0]?.error).toBe("series.errorCheck");
    await store.check("alice");

    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(store.list("alice")[0]?.error).toBeUndefined();
  });
  it("rejects invalid usernames before accessing storage", async () => {
    await expect(
      store.follow("../alice", feed(1), "ten", options),
    ).rejects.toThrow("Invalid username");
  });
});

describe("subscription limits", () => {
  it("pauses at ten, persists the reason and only resumes explicitly within capacity", async () => {
    const read = new Set<string>();
    outstanding.mockImplementation(
      (_username, ids) => ids.filter((id: string) => !read.has(id)).length,
    );
    const subscription = await store.follow("alice", feed(100), "ten", options);

    await Promise.all([store.check("alice"), store.check("alice")]);
    expect(enqueue).toHaveBeenCalledTimes(10);
    expect(store.list("alice")[0]).toMatchObject({
      paused: true,
      pauseReason: "limit",
    });
    await expect(store.pause("alice", subscription.id, false)).rejects.toThrow(
      "series.errorLimit",
    );
    read.add("episode-100");
    fetchFeed.mockResolvedValue(feed(200));
    await store.check("alice");
    expect(enqueue).toHaveBeenCalledTimes(10);
    await store.pause("alice", subscription.id, false);
    await store.check("alice");
    expect(enqueue).toHaveBeenCalledTimes(11);
    expect(store.list("alice")[0]).toMatchObject({
      paused: true,
      pauseReason: "limit",
    });
    expect(store.list("alice")[0]?.pending).toHaveLength(99);
    const restarted = createStore();
    await restarted.load(["alice"]);
    await restarted.check("alice");
    expect(enqueue).toHaveBeenCalledTimes(11);
    expect(restarted.list("alice")[0]?.pauseReason).toBe("limit");
    await restarted.stop();
  });
  it("keeps old episodes for deliberate batches, serialized against concurrent requests", async () => {
    const read = new Set<string>();
    outstanding.mockImplementation(
      (_username, ids) => ids.filter((id: string) => !read.has(id)).length,
    );
    fetchFeed.mockResolvedValue(feed(100));
    const subscription = await store.follow(
      "alice",
      feed(100),
      "none",
      options,
    );

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
    expect(enqueue).toHaveBeenCalledTimes(10);
    expect(store.list("alice")[0]?.archiveKeys).toHaveLength(90);
    read.add("episode-100");
    read.add("episode-99");
    expect(await store.backfill("alice", subscription.id)).toBe(2);
    expect(enqueue).toHaveBeenCalledTimes(12);
    expect(store.list("alice")[0]?.archiveKeys).toHaveLength(88);
    await expect(store.backfill("bob", subscription.id)).rejects.toThrow(
      "series.errorNotFound",
    );
  });
  it("preserves a manual pause and ignores unavailable archive episodes", async () => {
    const subscription = await store.follow(
      "alice",
      feed(100),
      "none",
      options,
    );
    await store.pause("alice", subscription.id, true);
    fetchFeed.mockResolvedValue(feed(2));

    expect(await store.backfill("alice", subscription.id)).toBe(2);
    expect(store.list("alice")[0]?.paused).toBe(true);
    await expect(store.backfill("alice", subscription.id)).rejects.toThrow(
      "series.errorNoHistory",
    );
  });
});
