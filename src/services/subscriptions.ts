import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { DomainError } from "../lib/errors.js";
import type {
  Backfill,
  Job,
  PodcastEpisode,
  PodcastFeed,
  PodcastSubscription,
} from "../types.js";

export const subscriptionLimit = 5;
export const subscriptionIntervalMs = 60 * 60 * 1000;
export function backfillEpisodes(
  feed: PodcastFeed,
  choice: Backfill,
): PodcastEpisode[] {
  return feed.episodes.slice(0, choice === "none" ? 0 : 3);
}

interface Dependencies {
  directory: (username: string) => string;
  fetchFeed: (url: string) => Promise<PodcastFeed>;
  enqueue: (
    username: string,
    episode: PodcastEpisode,
    options: Pick<Job, "language" | "articleLength">,
  ) => Promise<Pick<Job, "id">>;
  canProcess: () => boolean;
  outstanding: (username: string, ids: string[], keys: string[]) => number;
}

export class SubscriptionStore {
  private subscriptions = new Map<string, PodcastSubscription[]>();
  private operations = new Map<string, Promise<unknown>>();
  private timer?: ReturnType<typeof setInterval>;
  private stopped = false;

  constructor(private dependencies: Dependencies) {}

  private async exclusive<T>(
    username: string,
    action: () => Promise<T>,
  ): Promise<T> {
    this.dependencies.directory(username);
    const previous = this.operations.get(username) || Promise.resolve();
    const operation = previous.catch(() => undefined).then(action);
    this.operations.set(username, operation);
    try {
      return await operation;
    } finally {
      if (this.operations.get(username) === operation) {
        this.operations.delete(username);
      }
    }
  }

  async load(usernames: string[]): Promise<void> {
    for (const username of usernames) {
      const file = path.join(
        this.dependencies.directory(username),
        "subscriptions.json",
      );
      try {
        const stored: unknown = JSON.parse(await readFile(file, "utf8"));
        // Files are written by this service.
        // Refuse malformed state instead of overwriting it.
        if (!Array.isArray(stored) || !stored.every(validSubscription)) {
          throw new Error(`Invalid subscriptions file: ${file}`);
        }
        this.subscriptions.set(username, stored);
      } catch (error) {
        if (
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "ENOENT"
        ) {
          this.subscriptions.set(username, []);
        } else {
          throw error;
        }
      }
    }
  }

  list(username: string): PodcastSubscription[] {
    this.dependencies.directory(username);
    return structuredClone(this.subscriptions.get(username) || []);
  }

  private async save(
    username: string,
    items: PodcastSubscription[],
  ): Promise<void> {
    const directory = this.dependencies.directory(username);
    await mkdir(directory, { recursive: true });
    const file = path.join(directory, "subscriptions.json");
    const temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(items, null, 2));
    await rename(temporary, file);
    this.subscriptions.set(username, structuredClone(items));
  }

  async follow(
    username: string,
    feed: PodcastFeed,
    choice: Backfill,
    options: Pick<Job, "language" | "articleLength">,
  ) {
    return this.exclusive(username, async () => {
      const items = this.list(username);
      const existing = items.find((item) => item.feedUrl === feed.url);
      if (existing) {
        throw new DomainError("series.errorDuplicate");
      }
      const selected = backfillEpisodes(feed, choice);
      const selectedKeys = new Set(selected.map((item) => item.key));
      const subscription: PodcastSubscription = {
        language: options.language,
        articleLength: options.articleLength,
        id: randomUUID(),
        feedUrl: feed.url,
        title: feed.title,
        imageUrl: feed.imageUrl,
        paused: false,
        createdAt: new Date().toISOString(),
        seen: feed.episodes
          .filter((item) => !selectedKeys.has(item.key))
          .map((item) => item.key),
        archiveKeys: feed.episodes
          .slice(0, 3)
          .filter((item) => !selectedKeys.has(item.key))
          .map((item) => item.key),
        pending: selected,
        jobIds: [],
      };
      items.push(subscription);
      await this.save(username, items);
      return subscription;
    });
  }

  async pause(username: string, id: string, paused: boolean): Promise<void> {
    await this.exclusive(username, async () => {
      const items = this.list(username);
      const item = items.find((item) => item.id === id);
      if (!item) {
        throw new DomainError("series.errorNotFound");
      }
      if (!paused && this.outstanding(username, item) >= subscriptionLimit) {
        throw new DomainError("series.errorLimit");
      }
      item.paused = paused;
      item.pauseReason = undefined;
      await this.save(username, items);
    });
  }

  async check(username: string): Promise<void> {
    await this.exclusive(username, async () => {
      const items = this.list(username);
      for (const subscription of items) {
        if (this.stopped || subscription.paused) {
          continue;
        }
        try {
          if (!this.dependencies.canProcess()) {
            throw new DomainError("error.creationUnavailable");
          }
          if (await this.pauseAtLimit(username, items, subscription)) {
            continue;
          }
          // Commit the reviewed backlog before fetching again.
          // A feed outage must not lose it.
          const scheduled = await this.drain(username, items, subscription);
          if (subscription.paused || scheduled >= subscriptionLimit) {
            continue;
          }
          const feed = await this.dependencies.fetchFeed(subscription.feedUrl);
          subscription.imageUrl = feed.imageUrl;
          const latestKeys = new Set(
            feed.episodes.slice(0, 3).map((episode) => episode.key),
          );
          subscription.archiveKeys = (subscription.archiveKeys || []).filter(
            (key) => latestKeys.has(key),
          );
          const seen = new Set(subscription.seen);
          // An expanded feed can expose old archive entries for the first time.
          const firstKnown = feed.episodes.findIndex((episode) =>
            seen.has(episode.key),
          );
          subscription.pending = feed.episodes.filter((episode, index) => {
            if (seen.has(episode.key)) {
              return false;
            }
            const published = Date.parse(episode.episode.publishedAt || "");
            return Number.isFinite(published)
              ? published > Date.parse(subscription.createdAt)
              : firstKnown >= 0 && index < firstKnown;
          });
          subscription.checkedAt = new Date().toISOString();
          subscription.error = undefined;
          await this.save(username, items);
          await this.drain(
            username,
            items,
            subscription,
            subscriptionLimit - scheduled,
          );
        } catch (error) {
          subscription.error =
            error instanceof DomainError &&
            ["error.creationUnavailable", "error.accountBudget"].includes(
              error.code,
            )
              ? error.code
              : "series.errorCheck";
          await this.save(username, items);
        }
      }
    });
  }

  private async drain(
    username: string,
    items: PodcastSubscription[],
    subscription: PodcastSubscription,
    budget = subscriptionLimit,
  ) {
    let scheduled = 0;
    while (subscription.pending.length && !this.stopped && scheduled < budget) {
      if (await this.pauseAtLimit(username, items, subscription)) {
        break;
      }
      const episode = subscription.pending[0];
      if (!episode) {
        break;
      }
      const job = await this.dependencies.enqueue(
        username,
        episode,
        subscription,
      );
      scheduled += 1;
      if (!subscription.jobIds.includes(job.id)) {
        subscription.jobIds.push(job.id);
      }
      if (!subscription.seen.includes(episode.key)) {
        subscription.seen.push(episode.key);
      }
      subscription.pending.shift();
      // A crash between job creation and this commit is safe: enqueue deduplicates persisted jobs.
      await this.save(username, items);
    }
    await this.pauseAtLimit(username, items, subscription);
    return scheduled;
  }

  outstanding(username: string, subscription: PodcastSubscription): number {
    return this.dependencies.outstanding(
      username,
      subscription.jobIds,
      subscription.pending.map((item) => item.key),
    );
  }

  private async pauseAtLimit(
    username: string,
    items: PodcastSubscription[],
    subscription: PodcastSubscription,
  ): Promise<boolean> {
    if (this.outstanding(username, subscription) < subscriptionLimit) {
      return false;
    }
    subscription.paused = true;
    subscription.pauseReason = "limit";
    await this.save(username, items);
    return true;
  }

  async backfill(username: string, id: string): Promise<number> {
    return this.exclusive(username, async () => {
      const items = this.list(username);
      const subscription = items.find((item) => item.id === id);
      if (!subscription) {
        throw new DomainError("series.errorNotFound");
      }
      if (!this.dependencies.canProcess()) {
        throw new DomainError("error.creationUnavailable");
      }
      const available =
        subscriptionLimit -
        this.outstanding(username, subscription) -
        subscription.pending.length;
      if (available <= 0) {
        throw new DomainError("series.errorLimit");
      }
      const feed = await this.dependencies.fetchFeed(subscription.feedUrl);
      subscription.imageUrl = feed.imageUrl;
      const archive = new Set(subscription.archiveKeys || []);
      const selected = feed.episodes
        .slice(0, 3)
        .filter((item) => archive.has(item.key))
        .slice(0, Math.min(subscriptionLimit, available));
      if (!selected.length) {
        throw new DomainError("series.errorNoHistory");
      }
      const selectedKeys = new Set(selected.map((item) => item.key));
      subscription.archiveKeys = [...archive].filter(
        (key) => !selectedKeys.has(key),
      );
      subscription.pending.push(...selected);
      await this.save(username, items);
      // An explicit catch-up processes this batch without changing a manual pause.
      await this.drain(username, items, subscription);
      return selected.length;
    });
  }

  start(): void {
    const tick = () => {
      for (const username of this.subscriptions.keys()) {
        if (!this.operations.has(username)) {
          void this.check(username).catch((error) =>
            console.error("Podcast subscription check failed", error),
          );
        }
      }
    };
    this.timer = setInterval(tick, subscriptionIntervalMs);
    this.timer.unref();
    tick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    await Promise.allSettled(this.operations.values());
  }
}

function validSubscription(value: unknown): value is PodcastSubscription {
  if (!value || typeof value !== "object") {
    return false;
  }
  const item = value as Record<string, unknown>;
  return (
    typeof item.id === "string" &&
    typeof item.feedUrl === "string" &&
    typeof item.title === "string" &&
    (item.imageUrl === undefined || typeof item.imageUrl === "string") &&
    typeof item.language === "string" &&
    ["compact", "standard", "long"].includes(String(item.articleLength)) &&
    typeof item.paused === "boolean" &&
    (item.pauseReason === undefined || item.pauseReason === "limit") &&
    (item.archiveKeys === undefined ||
      (Array.isArray(item.archiveKeys) &&
        item.archiveKeys.every((key) => typeof key === "string"))) &&
    typeof item.createdAt === "string" &&
    Array.isArray(item.seen) &&
    item.seen.every((key) => typeof key === "string") &&
    Array.isArray(item.jobIds) &&
    item.jobIds.every((id) => typeof id === "string") &&
    Array.isArray(item.pending) &&
    item.pending.every((episode: unknown) => {
      if (
        !episode ||
        typeof episode !== "object" ||
        !("key" in episode) ||
        !("episode" in episode)
      ) {
        return false;
      }
      const metadata = episode.episode;
      return (
        typeof episode.key === "string" &&
        Boolean(
          metadata &&
          typeof metadata === "object" &&
          "sourceType" in metadata &&
          metadata.sourceType === "rss" &&
          "mediaUrl" in metadata &&
          typeof metadata.mediaUrl === "string",
        )
      );
    })
  );
}
