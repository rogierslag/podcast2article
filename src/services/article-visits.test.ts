import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { ArticleVisits } from "./article-visits.js";

it("persists visits per account and never regresses with concurrent older visits", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "article-visits-"));
  const directory = (username: string) => path.join(root, username);
  const visits = new ArticleVisits(directory);
  try {
    await visits.checkpoint("alice", "2026-09-01T00:00:00.000Z");
    await Promise.all([
      visits.checkpoint("alice", "2026-09-03T00:00:00.000Z"),
      visits.checkpoint("alice", "2026-09-02T00:00:00.000Z"),
      visits.checkpoint("bob", "2026-09-01T00:00:00.000Z"),
    ]);

    const restarted = new ArticleVisits(directory);
    expect(await restarted.checkpoint("alice")).toBe(
      "2026-09-03T00:00:00.000Z",
    );
    expect(await restarted.checkpoint("bob")).toBe("2026-09-01T00:00:00.000Z");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("starts a first visit at the present instead of flagging the existing backlog", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "article-visits-"));
  try {
    const visits = new ArticleVisits(() => root);
    const before = Date.now();

    const checkpoint = await visits.checkpoint("alice");

    expect(Date.parse(checkpoint)).toBeGreaterThanOrEqual(before);
    expect(await visits.checkpoint("alice")).toBe(checkpoint);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("counts only new completed articles in followed series, including paused series", async () => {
  const { countArticleArrivals } = await import("./article-visits.js");
  const articles = ["old", "new", "manual"].map((id) => ({
    id,
    title: id,
    dek: "Episode",
    readingTimeMinutes: 5,
    sourceName: "A podcast",
    sourceType: "spotify" as const,
    completedAt: id === "old" ? "2026-09-01T00:00:00Z" : "2026-09-02T00:00:00Z",
  }));
  const subscriptions = [
    {
      id: "series",
      feedUrl: "https://example.com/feed",
      title: "A podcast",
      language: "en",
      articleLength: "standard" as const,
      paused: true,
      createdAt: "2026-09-01T00:00:00Z",
      seen: [],
      jobIds: ["old", "new", "pending"],
      pending: [],
    },
  ];

  expect(
    countArticleArrivals(articles, subscriptions, "2026-09-01T00:00:00.000Z"),
  ).toBe(1);
  expect(countArticleArrivals(articles, [], "2026-09-01T00:00:00.000Z")).toBe(
    0,
  );
  expect(
    countArticleArrivals(articles, subscriptions, "2026-09-02T00:00:00.000Z"),
  ).toBe(0);
});
