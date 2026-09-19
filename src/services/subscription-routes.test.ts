import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchPodcastFeed, discoverPodcastFeeds } from "./podcast-feeds.js";
import { subscriptionRouter } from "./subscription-routes.js";
import { SubscriptionStore } from "./subscriptions.js";
import type { PodcastFeed } from "../types.js";
vi.mock("./podcast-feeds.js", () => ({
  fetchPodcastFeed: vi.fn(),
  discoverPodcastFeeds: vi.fn(),
}));
vi.mock("./jobs.js", () => ({
  podcastJobStatus: vi.fn(() => ({ complete: 0, processing: 0, failed: [] })),
}));
let server: Server;
let base: string;
let root: string;
let store: SubscriptionStore;
const enqueue = vi.fn();
const feed: PodcastFeed = {
  url: "https://example.com/feed",
  title: "Public podcast",
  episodes: [
    {
      key: "one",
      episode: {
        sourceType: "rss",
        sourceUrl: "https://example.com/one",
        mediaUrl: "https://example.com/one.mp3",
        title: "Episode one",
        sourceName: "Public podcast",
      },
    },
  ],
};
async function request(
  route: string,
  method = "GET",
  body?: unknown,
  username = "alice",
) {
  return fetch(base + route, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-Test-User": username,
      "Accept-Language": "en",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
beforeEach(async () => {
  vi.stubEnv("OPENAI_API_KEY", "test-only-not-a-real-key");
  vi.resetAllMocks();
  vi.mocked(fetchPodcastFeed).mockResolvedValue(feed);
  enqueue.mockImplementation(async (_username, item) => ({ id: item.key }));
  root = await mkdtemp(path.join(tmpdir(), "p2a-subscription-api-test-"));
  store = new SubscriptionStore({
    directory: (username) => path.join(root, username),
    fetchFeed: fetchPodcastFeed,
    enqueue,
    outstanding: () => 0,
    canProcess: () => true,
  });
  await store.load(["alice", "bob"]);
  const app = express();
  app.use(express.json());
  // Authentication itself is exercised by the compiled-server smoke tests.
  app.use((req, res, next) => {
    res.locals.username = req.get("X-Test-User");
    next();
  });
  app.use(subscriptionRouter(store));
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Missing address");
  }
  base = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => {
  await store.stop();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await rm(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
describe("subscription API", () => {
  it("requires a server-owned preview scoped to the current account", async () => {
    const previewResponse = await request("/preview", "POST", {
      url: feed.url,
    });
    const preview = await previewResponse.json();

    const other = await request(
      "/",
      "POST",
      { previewId: preview.id, backfill: "ten" },
      "bob",
    );
    const followed = await request("/", "POST", {
      previewId: preview.id,
      backfill: "ten",
      episode: { mediaUrl: "http://localhost/private" },
    });
    await store.check("alice");

    expect(other.status).toBe(400);
    expect(followed.status).toBe(202);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0]?.[1].episode.mediaUrl).toBe(
      feed.episodes[0]?.episode.mediaUrl,
    );
    const ownList = await (await request("/")).json();
    expect(ownList[0]).not.toHaveProperty("seen");
    expect(ownList[0]).not.toHaveProperty("pending");
    expect(ownList[0]).not.toHaveProperty("previewId");
    expect(await (await request("/", "GET", undefined, "bob")).json()).toEqual(
      [],
    );
    expect(
      (await request(`/${ownList[0].id}`, "PATCH", { paused: true }, "bob"))
        .status,
    ).toBe(404);
  });
  it("rejects expired and replaced previews, invalid choices and missing processing configuration", async () => {
    const preview = await (
      await request("/preview", "POST", { url: feed.url })
    ).json();
    expect(
      (
        await request("/", "POST", {
          previewId: preview.id,
          backfill: "all",
        })
      ).status,
    ).toBe(400);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 16 * 60 * 1000);
    expect(
      (await request("/", "POST", { previewId: preview.id, backfill: "ten" }))
        .status,
    ).toBe(400);
    vi.restoreAllMocks();
    const replacement = await (
      await request("/preview", "POST", { url: feed.url })
    ).json();
    expect(
      (await request("/", "POST", { previewId: preview.id, backfill: "ten" }))
        .status,
    ).toBe(400);
    vi.stubEnv("OPENAI_API_KEY", "");
    expect(
      (
        await request("/", "POST", {
          previewId: replacement.id,
          backfill: "ten",
        })
      ).status,
    ).toBe(503);
    expect(store.list("alice")).toEqual([]);
  });
  it("returns localized discovery failures without leaking network details", async () => {
    vi.mocked(discoverPodcastFeeds).mockRejectedValue(
      new Error("secret internal host"),
    );

    const response = await request("/discover", "POST", {
      url: "https://example.com/feed",
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error:
        "This public feed could not be read. Check the link and try again.",
    });
  });
});
