import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { requestLanguage } from "../lib/i18n.js";
import { translate } from "../../public/i18n.js";
import type { PodcastFeed } from "../types.js";
import { discoverPodcastFeeds, fetchPodcastFeed } from "./podcast-feeds.js";
import { podcastJobStatus } from "./jobs.js";
import type { SubscriptionStore } from "./subscriptions.js";

export function subscriptionRouter(store: SubscriptionStore) {
  const router = Router();
  const previews = new Map<
    string,
    { id: string; expires: number; feed: PodcastFeed }
  >();
  const urlSchema = z.object({ url: z.string().url().max(2000) });
  const followSchema = z.object({
    previewId: z.string().uuid(),
    backfill: z.enum(["none", "latest", "ten"]),
    language: z.enum(["auto", "nl", "en", "de", "fr", "es"]).default("auto"),
    articleLength: z.enum(["compact", "standard", "long"]).default("standard"),
  });
  function check(username: string) {
    void store
      .check(username)
      .catch((error) =>
        console.error("Podcast subscription check failed", error),
      );
  }
  router.use((_request, response, next) => {
    response.setHeader("Cache-Control", "no-store");
    next();
  });
  router.get("/", (_request, response) => {
    const username: string = response.locals.username;
    response.json(
      store
        .list(username)
        .map(({ jobIds, seen: _seen, archiveKeys, pending, ...item }) => ({
          ...item,
          pendingCount: pending.length,
          archiveCount: archiveKeys?.length || 0,
          outstanding: store.outstanding(username, {
            ...item,
            jobIds,
            seen: _seen,
            pending,
          }),
          ...podcastJobStatus(username, jobIds),
        })),
    );
  });
  router.post("/discover", async (request, response) => {
    const input = urlSchema.parse(request.body);
    response.json(await discoverPodcastFeeds(input.url));
  });
  router.post("/preview", async (request, response) => {
    const input = urlSchema.parse(request.body);
    const feed = await fetchPodcastFeed(input.url);
    const id = randomUUID();
    previews.set(response.locals.username, {
      id,
      expires: Date.now() + 15 * 60 * 1000,
      feed,
    });
    response.json({
      id,
      title: feed.title,
      imageUrl: feed.imageUrl,
      url: feed.url,
      count: feed.episodes.length,
      episodes: feed.episodes.slice(0, 3).map(({ episode }) => ({
        title: episode.title,
        publishedAt: episode.publishedAt,
      })),
    });
  });
  router.post("/", async (request, response) => {
    const input = followSchema.parse(request.body);
    const username: string = response.locals.username;
    const preview = previews.get(username);
    if (
      !preview ||
      preview.id !== input.previewId ||
      preview.expires < Date.now()
    ) {
      throw new Error("series.errorPreview");
    }
    if (!process.env.OPENAI_API_KEY) {
      throw new Error("error.creationUnavailable");
    }
    const subscription = await store.follow(
      username,
      preview.feed,
      input.backfill,
      input,
    );
    previews.delete(username);
    response.status(202).json({ id: subscription.id });
    check(username);
  });
  router.post("/:id/backfill", async (request, response) => {
    const count = await store.backfill(
      response.locals.username,
      request.params.id,
    );
    response.status(202).json({ count });
  });
  router.patch("/:id", async (request, response) => {
    const { paused } = z.object({ paused: z.boolean() }).parse(request.body);
    const username: string = response.locals.username;
    await store.pause(username, request.params.id, paused);
    response.json({ paused });
    if (!paused) {
      check(username);
    }
  });
  router.use(
    (
      error: unknown,
      request: import("express").Request,
      response: import("express").Response,
      _next: import("express").NextFunction,
    ) => {
      const key =
        error instanceof Error &&
        /^(series\.error\w+|error.creationUnavailable)$/.test(error.message)
          ? error.message
          : error instanceof z.ZodError
            ? "error.input"
            : "series.errorFeed";
      response
        .status(
          key === "series.errorNotFound"
            ? 404
            : key === "series.errorDuplicate" || key === "series.errorLimit"
              ? 409
              : key === "error.creationUnavailable"
                ? 503
                : 400,
        )
        .json({
          error: translate(
            requestLanguage(
              request.get("Accept-Language"),
              request.headers.cookie,
            ),
            key,
          ),
        });
    },
  );
  return router;
}
