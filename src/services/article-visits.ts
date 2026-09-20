import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ArticleSummary, PodcastSubscription } from "../types.js";

export function countArticleArrivals(
  articles: ArticleSummary[],
  subscriptions: PodcastSubscription[],
  checkpoint: string,
): number {
  const followedJobs = new Set(
    subscriptions.flatMap((subscription) => subscription.jobIds),
  );
  return articles.filter(
    (article) =>
      followedJobs.has(article.id) &&
      Date.parse(article.completedAt) > Date.parse(checkpoint),
  ).length;
}

// Serialize visits per account so an older tab cannot move the checkpoint backwards.
export class ArticleVisits {
  private operations = new Map<string, Promise<string>>();

  constructor(private directory: (username: string) => string) {}

  checkpoint(username: string, visitedAt?: string): Promise<string> {
    const directory = this.directory(username);
    const previous = this.operations.get(username) ?? Promise.resolve("");
    const operation = previous
      .catch(() => "")
      .then(async () => {
        const file = path.join(directory, "article-visit.json");
        let stored: string | undefined;
        try {
          const value: unknown = JSON.parse(await readFile(file, "utf8"));
          if (
            typeof value !== "string" ||
            !Number.isFinite(Date.parse(value))
          ) {
            throw new Error("Invalid article visit checkpoint");
          }
          stored = value;
        } catch (error) {
          if (!(
            error &&
            typeof error === "object" &&
            "code" in error &&
            error.code === "ENOENT"
          )) {
            throw error;
          }
        }
        const next =
          stored && (!visitedAt || stored > visitedAt)
            ? stored
            : (visitedAt ?? new Date().toISOString());
        if (next !== stored) {
          await mkdir(directory, { recursive: true });
          await writeFile(`${file}.tmp`, JSON.stringify(next));
          await rename(`${file}.tmp`, file);
        }
        return next;
      });
    this.operations.set(username, operation);
    void operation
      .finally(() => {
        if (this.operations.get(username) === operation) {
          this.operations.delete(username);
        }
      })
      .catch(() => undefined);
    return operation;
  }
}
