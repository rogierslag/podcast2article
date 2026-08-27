import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "../types.js";

const storage = vi.hoisted(() => ({ files: new Map<string, string>() }));

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
  mkdir: vi.fn(),
  readFile: vi.fn(async (file: string) => {
    const content = storage.files.get(file);
    if (content === undefined) {
      throw new Error("ENOENT");
    }
    return content;
  }),
  writeFile: vi.fn(async (file: string, content: string) => {
    storage.files.set(file, content);
  }),
  readdir: vi.fn(async (directory: string) =>
    [...storage.files.keys()]
      .filter((file) => path.dirname(file) === directory)
      .map((file) => path.basename(file)),
  ),
}));

const articleId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const shareToken = "a".repeat(43);

function storedPath(username: string): string {
  return path.resolve("data", "users", username, "jobs", `${articleId}.json`);
}

function storeArticle(username: string, patch: Partial<Job> = {}): Job {
  const job: Job = {
    id: articleId,
    sourceUrl: "https://youtube.com/watch?v=example",
    language: "nl",
    articleLength: "standard",
    stage: "complete",
    progress: 100,
    message: "Klaar",
    createdAt: "2026-08-01T12:00:00.000Z",
    updatedAt: "2026-08-01T12:00:00.000Z",
    completedAt: "2026-08-01T12:00:00.000Z",
    shareToken,
    episode: {
      sourceType: "youtube",
      sourceUrl: "https://youtube.com/watch?v=example",
      sourceName: "De werkweek",
      title: "Ruimte voor aandacht",
      mediaUrl: "https://example.com/source.mp3",
    },
    transcript: [
      {
        id: "s1",
        start: 0,
        end: 30,
        speaker: "A",
        text: "Meer rust geeft ruimte voor aandacht.",
      },
    ],
    article: {
      title: "Ruimte voor aandacht",
      dek: "Waarom rust essentieel is voor goed werk.",
      readingTimeMinutes: 3,
      styleNote: "Helder en bondig.",
      sections: [],
      takeaways: [],
    },
    ...patch,
  };
  storage.files.set(storedPath(username), JSON.stringify(job));
  return job;
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  storage.files.clear();
});

describe("article soft deletion", () => {
  it.each([undefined, "2026-08-02T12:00:00.000Z"])(
    "hides read/unread articles while retaining their content and media (%s)",
    async (readAt) => {
      const original = storeArticle("owner", { readAt });
      const mediaPath = path.resolve(
        "data/users/owner/media",
        `${articleId}.mp3`,
      );
      storage.files.set(mediaPath, "retained audio");
      const jobs = await import("./jobs.js");
      await jobs.getJob("owner", articleId);
      expect(jobs.listReadyArticles("owner")).toHaveLength(1);
      expect(jobs.getSharedArticle(shareToken)).toBeDefined();

      await jobs.deleteArticle("owner", articleId);

      expect(jobs.listReadyArticles("owner")).toEqual([]);
      expect(jobs.listProcessingJobs("owner")).toEqual([]);
      expect(await jobs.getJob("owner", articleId)).toBeUndefined();
      expect(jobs.getSharedArticle(shareToken)).toBeUndefined();
      const stored = JSON.parse(storage.files.get(storedPath("owner")) ?? "{}");
      expect(stored).toMatchObject({
        id: original.id,
        article: original.article,
        episode: original.episode,
        transcript: original.transcript,
        shareToken: original.shareToken,
        completedAt: original.completedAt,
        deletedAt: expect.any(String),
      });
      expect(stored.readAt).toBe(readAt);
      expect(storage.files.get(mediaPath)).toBe("retained audio");
    },
  );

  it("preserves deletion across restart and repeated requests", async () => {
    storeArticle("owner");
    const jobs = await import("./jobs.js");
    await jobs.deleteArticle("owner", articleId);
    const stored = storage.files.get(storedPath("owner"));
    vi.resetModules();
    const restartedJobs = await import("./jobs.js");

    await restartedJobs.resumeIncompleteJobs(["owner"]);
    await restartedJobs.deleteArticle("owner", articleId);

    expect(await restartedJobs.getJob("owner", articleId)).toBeUndefined();
    expect(restartedJobs.listReadyArticles("owner")).toEqual([]);
    expect(restartedJobs.getSharedArticle(shareToken)).toBeUndefined();
    expect(storage.files.get(storedPath("owner"))).toBe(stored);
  });

  it("only deletes the authenticated user's copy of a job", async () => {
    storeArticle("owner");
    storeArticle("other");
    const otherCopy = storage.files.get(storedPath("other"));
    const jobs = await import("./jobs.js");

    await jobs.deleteArticle("owner", articleId);

    expect(await jobs.getJob("other", articleId)).toBeDefined();
    expect(jobs.listReadyArticles("other")).toHaveLength(1);
    expect(storage.files.get(storedPath("other"))).toBe(otherCopy);
    await expect(jobs.deleteArticle("stranger", articleId)).rejects.toThrow(
      "Opdracht niet gevonden.",
    );
  });

  it.each(["../owner", "not-a-uuid", "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee"])(
    "rejects malformed or missing IDs: %s",
    async (id) => {
      storeArticle("owner");
      const jobs = await import("./jobs.js");

      await expect(jobs.deleteArticle("owner", id)).rejects.toThrow(
        "Opdracht niet gevonden.",
      );
    },
  );

  it("rejects unfinished articles and invalid usernames", async () => {
    storeArticle("owner", { stage: "writing" });
    const jobs = await import("./jobs.js");

    await expect(jobs.deleteArticle("owner", articleId)).rejects.toThrow(
      "nog niet klaar",
    );
    await expect(jobs.deleteArticle("../owner", articleId)).rejects.toThrow(
      "Opdracht niet gevonden.",
    );
    expect(await jobs.getJob("owner", articleId)).not.toHaveProperty(
      "deletedAt",
    );
  });

  it("blocks read state, sharing and regeneration of deleted articles", async () => {
    storeArticle("owner");
    const jobs = await import("./jobs.js");
    await jobs.deleteArticle("owner", articleId);

    await expect(jobs.setArticleRead("owner", articleId, true)).rejects.toThrow(
      "Opdracht niet gevonden.",
    );
    await expect(jobs.createArticleShare("owner", articleId)).rejects.toThrow(
      "Opdracht niet gevonden.",
    );
    await expect(jobs.retryArticle("owner", articleId)).rejects.toThrow(
      "Opdracht niet gevonden.",
    );
    await expect(
      jobs.setArticleReadingPosition("owner", articleId, 0),
    ).rejects.toThrow("Opdracht niet gevonden.");
  });

  it("does not reveal deleted articles through duplicate detection", async () => {
    const original = storeArticle("owner", {
      sourceUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    });
    const jobs = await import("./jobs.js");
    await jobs.deleteArticle("owner", articleId);
    const deleted = JSON.parse(storage.files.get(storedPath("owner")) ?? "{}");

    expect(
      jobs.findDuplicateJob([deleted], original.sourceUrl),
    ).toBeUndefined();
    expect(jobs.findDuplicateJob([deleted, original], original.sourceUrl)).toBe(
      original,
    );
  });

  it("keeps the article visible when saving deletion fails, allowing retry", async () => {
    storeArticle("owner");
    const jobs = await import("./jobs.js");
    const { writeFile } = await import("node:fs/promises");
    vi.mocked(writeFile).mockRejectedValueOnce(new Error("Disk full"));

    await expect(jobs.deleteArticle("owner", articleId)).rejects.toThrow(
      "Disk full",
    );

    expect(await jobs.getJob("owner", articleId)).toBeDefined();
    expect(jobs.listReadyArticles("owner")).toHaveLength(1);
    await jobs.deleteArticle("owner", articleId);
    expect(await jobs.getJob("owner", articleId)).toBeUndefined();
  });
});
