import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiRequestUsage, Job } from "../types.js";

const state = vi.hoisted(() => ({
  files: new Map<string, string>(),
  resolveSource: vi.fn(),
  writeFile: vi.fn(),
  download: vi.fn(),
  normalize: vi.fn(),
  transcribe: vi.fn(),
  writeArticle: vi.fn(),
}));
vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof import("node:fs/promises")>()),
  mkdir: vi.fn(),
  stat: vi.fn(async () => ({ size: 1024 })),
  rename: vi.fn(),
  rm: vi.fn().mockResolvedValue(undefined),
  writeFile: state.writeFile,
  readFile: vi.fn(async (file: string) => {
    const content = state.files.get(file);
    if (content === undefined) {
      throw new Error("ENOENT");
    }
    return content;
  }),
  readdir: vi.fn(async (directory: string) =>
    [...state.files.keys()]
      .filter((file) => path.dirname(file) === directory)
      .map((file) => path.basename(file)),
  ),
}));
vi.mock("./resolver.js", async (original) => ({
  ...(await original<typeof import("./resolver.js")>()),
  resolveSource: state.resolveSource,
}));
vi.mock("./youtube.js", async (original) => ({
  ...(await original<typeof import("./youtube.js")>()),
  downloadYouTubeAudio: state.download,
}));
vi.mock("./audio.js", () => ({
  audioChunkSeconds: () => 600,
  downloadMedia: state.download,
  normalizeAudio: state.normalize,
  splitAudio: vi.fn(async () => ["chunk.mp3"]),
}));
vi.mock("./openai.js", () => ({
  transcribeChunks: state.transcribe,
  writeArticle: state.writeArticle,
}));
vi.mock("../lib/logger.js", () => ({ jobLog: vi.fn(), jobError: vi.fn() }));
const input = {
  sourceUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  language: "auto",
  articleLength: "standard",
} satisfies Pick<Job, "sourceUrl" | "language" | "articleLength">;

beforeEach(() => {
  vi.resetModules();
  state.files.clear();
  state.writeArticle
    .mockReset()
    .mockResolvedValue({ title: "An article", sections: [] });
  state.download.mockReset().mockResolvedValue(undefined);
  state.normalize.mockReset().mockResolvedValue(undefined);
  state.transcribe.mockReset().mockImplementation(
    (_files, _language, _progress, _status, signal: AbortSignal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      }),
  );
  state.writeFile
    .mockReset()
    .mockImplementation(async (file: string, content: string) => {
      state.files.set(file, content);
    });
  // Hold processing at the network boundary. Shutdown must cancel this request.
  state.resolveSource.mockReset().mockImplementation(
    (_url: string, signal: AbortSignal) =>
      new Promise((_resolve, reject) => {
        if (signal.aborted) {
          reject(signal.reason);
          return;
        }
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      }),
  );
});
afterEach(async () => {
  const jobs = await import("./jobs.js");
  await jobs.shutdownJobs();
});

describe("processing reservations and concurrent queue", () => {
  it("reserves a canonical source before the first persistence completes", async () => {
    const jobs = await import("./jobs.js");
    let release = () => {};
    state.writeFile.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const first = jobs.createJob("owner", input);

    await expect(
      jobs.createJob("owner", {
        ...input,
        sourceUrl: "https://youtu.be/dQw4w9WgXcQ?t=12",
      }),
    ).rejects.toBeInstanceOf(jobs.DuplicateJobError);
    release();
    await first;

    expect(jobs.listProcessingJobs("owner")).toHaveLength(1);
  });

  it("releases a failed persistence reservation so the user can retry", async () => {
    const jobs = await import("./jobs.js");
    state.writeFile.mockRejectedValueOnce(new Error("disk full"));

    await expect(jobs.createJob("owner", input)).rejects.toThrow("disk full");
    const retry = await jobs.createJob("owner", input);

    expect(jobs.listProcessingJobs("owner").map((job) => job.id)).toEqual([
      retry.id,
    ]);
  });

  it("keeps accounts isolated while resolving sources concurrently and isolates failures", async () => {
    const jobs = await import("./jobs.js");
    let failFirst = (_error: Error) => {};
    state.resolveSource.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          failFirst = reject;
        }),
    );
    const first = await jobs.createJob("owner", input);
    const second = await jobs.createJob("other", input);
    await vi.waitFor(() =>
      expect(state.resolveSource).toHaveBeenCalledTimes(2),
    );

    expect(jobs.listProcessingJobs("owner").map((job) => job.id)).toEqual([
      first.id,
    ]);
    expect(jobs.listProcessingJobs("other").map((job) => job.id)).toEqual([
      second.id,
    ]);
    failFirst(new Error("source unavailable"));
    await vi.waitFor(() =>
      expect(state.resolveSource).toHaveBeenCalledTimes(2),
    );

    expect((await jobs.getJob("owner", first.id))?.stage).toBe("failed");
    expect((await jobs.getJob("other", second.id))?.stage).toBe("resolving");
  });

  it("shutdown persists interrupted work and restart resumes it without losing queued work", async () => {
    const jobs = await import("./jobs.js");
    const first = await jobs.createJob("owner", input);
    const second = await jobs.createJob("other", input);
    await vi.waitFor(() =>
      expect(state.resolveSource).toHaveBeenCalledTimes(2),
    );

    await jobs.shutdownJobs();
    vi.resetModules();
    state.resolveSource.mockClear();
    const restarted = await import("./jobs.js");
    await restarted.resumeIncompleteJobs(["owner", "other"]);
    await vi.waitFor(() =>
      expect(state.resolveSource).toHaveBeenCalledTimes(2),
    );

    expect(restarted.listProcessingJobs("owner").map((job) => job.id)).toEqual([
      first.id,
    ]);
    expect(restarted.listProcessingJobs("other")).toMatchObject([
      { id: second.id, stage: "resolving" },
    ]);
  });
});

function resolveMetadata() {
  state.resolveSource.mockImplementation(async (sourceUrl: string) => ({
    sourceUrl,
    sourceType: "youtube",
    sourceName: "The Knowledge Project",
    title: "How to make better decisions",
    imageUrl: "https://example.com/cover.jpg",
    mediaUrl: "",
  }));
}

describe("independent metadata and media processing", () => {
  it("fetches queued titles and artwork while three transcriptions are waiting", async () => {
    resolveMetadata();
    const jobs = await import("./jobs.js");
    for (const username of ["one", "two", "three", "four", "five"]) {
      await jobs.createJob(username, input);
    }

    await vi.waitFor(() => {
      expect(state.resolveSource).toHaveBeenCalledTimes(5);
      expect(state.transcribe).toHaveBeenCalledTimes(3);
      expect(jobs.listProcessingJobs("five")[0]).toMatchObject({
        stage: "queued",
        title: "How to make better decisions",
        sourceName: "The Knowledge Project",
        imageUrl: "https://example.com/cover.jpg",
      });
    });
    expect(state.download).toHaveBeenCalledTimes(3);

    await jobs.shutdownJobs();
    expect(state.download).toHaveBeenCalledTimes(3);
    for (const username of ["one", "two", "three", "four", "five"]) {
      expect(jobs.listProcessingJobs(username)[0]?.stage).toBe("queued");
    }
  });

  it("advances waiting jobs when a transcription fails", async () => {
    resolveMetadata();
    let failTranscription = (_error: Error) => {};
    state.transcribe.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          failTranscription = reject;
        }),
    );
    const jobs = await import("./jobs.js");
    const first = await jobs.createJob("one", input);
    for (const username of ["two", "three", "four"]) {
      await jobs.createJob(username, input);
    }
    await vi.waitFor(() => expect(state.transcribe).toHaveBeenCalledTimes(3));

    failTranscription(new Error("Transcription unavailable"));
    await vi.waitFor(() => expect(state.transcribe).toHaveBeenCalledTimes(4));

    expect((await jobs.getJob("one", first.id))?.stage).toBe("failed");
    expect(jobs.listProcessingJobs("four")[0]?.stage).toBe("transcribing");
  });

  it("serializes media preparation and releases the slot after failure", async () => {
    resolveMetadata();
    let failNormalization = (_error: Error) => {};
    state.normalize.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          failNormalization = reject;
        }),
    );
    const jobs = await import("./jobs.js");
    const first = await jobs.createJob("one", input);
    await jobs.createJob("two", input);
    await vi.waitFor(() => expect(state.normalize).toHaveBeenCalledTimes(1));

    expect(state.download).toHaveBeenCalledTimes(1);
    expect(state.transcribe).not.toHaveBeenCalled();
    failNormalization(new Error("FFmpeg failed"));
    await vi.waitFor(() => expect(state.transcribe).toHaveBeenCalledTimes(1));

    expect(state.download).toHaveBeenCalledTimes(2);
    expect((await jobs.getJob("one", first.id))?.stage).toBe("failed");
  });

  it("limits metadata requests independently and cancels waiting lookups at shutdown", async () => {
    const jobs = await import("./jobs.js");
    for (const username of ["one", "two", "three", "four", "five"]) {
      await jobs.createJob(username, input);
    }
    await vi.waitFor(() =>
      expect(state.resolveSource).toHaveBeenCalledTimes(3),
    );

    await jobs.shutdownJobs();

    expect(state.resolveSource).toHaveBeenCalledTimes(3);
    expect(state.download).not.toHaveBeenCalled();
  });
});

it("persists usage through failure and restart without duplicating attempt updates", async () => {
  resolveMetadata();
  const entry: ApiRequestUsage = {
    id: "test-attempt",
    operationId: "test-operation",
    attempt: 1,
    stage: "transcription",
    requestedModel: "gpt-4o-transcribe-diarize",
    requestedServiceTier: "default",
    endpointRegion: "global",
    startedAt: "2026-09-15T10:00:00Z",
    status: "pending",
    cost: { currency: "USD", amount: null },
  };
  state.transcribe.mockImplementationOnce(
    async (_files, _language, onProgress, _status, _signal, recordUsage) => {
      await recordUsage(entry);
      onProgress(1, 2);
      await recordUsage({
        ...entry,
        status: "succeeded",
        audioSeconds: 30,
        cost: { currency: "USD", amount: 0.003 },
      });
      await recordUsage({
        ...entry,
        id: "test-failed-attempt",
        attempt: 2,
        status: "failed",
      });
      throw new Error("Second chunk failed");
    },
  );
  const jobs = await import("./jobs.js");
  const job = await jobs.createJob("owner", input);
  await vi.waitFor(async () =>
    expect((await jobs.getJob("owner", job.id))?.stage).toBe("failed"),
  );
  await jobs.shutdownJobs();

  vi.resetModules();
  const restarted = await import("./jobs.js");
  await restarted.resumeIncompleteJobs(["owner"]);
  const restored = await restarted.getJob("owner", job.id);

  expect(restored?.apiUsage).toMatchObject({
    coverage: "complete",
    knownEstimatedCostUsd: 0.003,
    unknownCostRequests: 1,
  });
  expect(restored?.apiUsage?.requests).toHaveLength(2);
  expect(restored?.apiUsage?.requests[0]?.status).toBe("succeeded");
  expect(restarted.listProcessingJobs("other")).toEqual([]);
});

it("keeps earlier charges when retrying article generation", async () => {
  resolveMetadata();
  state.transcribe.mockResolvedValue([
    { id: "t-00001", start: 0, end: 1, speaker: "Alice", text: "Hello" },
  ]);
  let requests = 0;
  state.writeArticle.mockImplementation(
    async (_transcript, _metadata, _status, _signal, recordUsage) => {
      requests += 1;
      await recordUsage({
        id: `article-attempt-${requests}`,
        operationId: `operation-${requests}`,
        attempt: 1,
        stage: "article",
        requestedModel: "gpt-5.6-terra",
        requestedServiceTier: "auto",
        endpointRegion: "global",
        startedAt: "2026-09-15T10:00:00Z",
        status: "succeeded",
        cost: { currency: "USD", amount: 0.01 },
      } satisfies ApiRequestUsage);
      if (requests === 1) {
        throw new Error("Generated article failed validation");
      }
      return { title: "An article", sections: [] };
    },
  );
  const jobs = await import("./jobs.js");
  const job = await jobs.createJob("owner", input);
  await vi.waitFor(async () =>
    expect((await jobs.getJob("owner", job.id))?.stage).toBe("failed"),
  );

  await jobs.retryArticle("owner", job.id);
  await vi.waitFor(async () =>
    expect((await jobs.getJob("owner", job.id))?.stage).toBe("complete"),
  );

  expect((await jobs.getJob("owner", job.id))?.apiUsage).toMatchObject({
    knownEstimatedCostUsd: 0.02,
    unknownCostRequests: 0,
  });
  expect((await jobs.getJob("owner", job.id))?.apiUsage?.requests).toHaveLength(
    2,
  );
  expect(state.transcribe).toHaveBeenCalledTimes(1);
});

describe("podcast jobs", () => {
  const episode = {
    key: "stable-feed-guid",
    episode: {
      sourceType: "rss" as const,
      sourceUrl: "https://example.com/episodes/one",
      sourceName: "A public podcast",
      title: "Episode one",
      mediaUrl: "https://example.com/one.mp3",
    },
  };
  it("reserves a feed episode once, preserves resolved metadata and isolates accounts", async () => {
    const jobs = await import("./jobs.js");
    await jobs.createJob("owner", input);

    const subscriptionOptions = { ...input, pending: [episode] };
    const [first, repeated] = await Promise.all([
      jobs.createPodcastJob("owner", episode, subscriptionOptions),
      jobs.createPodcastJob(
        "owner",
        {
          ...episode,
          episode: {
            ...episode.episode,
            mediaUrl: "https://example.com/changed.mp3",
          },
        },
        input,
      ),
    ]);
    const other = await jobs.createPodcastJob("other", episode, input);

    expect(repeated.id).toBe(first.id);
    expect(other.id).not.toBe(first.id);
    await vi.waitFor(() => {
      expect(first.stage).toBe("transcribing");
      expect(other.stage).toBe("transcribing");
    });
    expect(state.resolveSource).toHaveBeenCalledTimes(1);
    expect(state.download).toHaveBeenCalledWith(
      episode.episode.mediaUrl,
      expect.any(String),
      expect.any(AbortSignal),
      expect.any(Object),
    );
    expect(first.episode).toMatchObject(episode.episode);
    expect(first.podcastEpisodeKey).toBe(episode.key);
    expect(first.apiUsage).toMatchObject({
      coverage: "complete",
      requests: [],
      knownEstimatedCostUsd: 0,
      unknownCostRequests: 0,
    });
    expect(first).not.toHaveProperty("pending");
    expect(jobs.podcastJobStatus("owner", [first.id]).processing).toBe(1);
  });
  it("does not recreate a completed podcast job after loading persisted state", async () => {
    const jobs = await import("./jobs.js");
    const completed = {
      ...input,
      id: "00000000-0000-4000-8000-000000000772",
      sourceUrl: episode.episode.sourceUrl,
      podcastEpisodeKey: episode.key,
      episode: episode.episode,
      stage: "complete",
      progress: 100,
      message: "Klaar",
      createdAt: "2026-09-01T10:00:00Z",
      updatedAt: "2026-09-01T10:00:00Z",
    } satisfies Job;
    state.files.set(
      path.resolve("data/users/owner/jobs", `${completed.id}.json`),
      JSON.stringify(completed),
    );
    await jobs.resumeIncompleteJobs(["owner"]);

    const repeated = await jobs.createPodcastJob("owner", episode, input);

    expect(repeated.id).toBe(completed.id);
    expect(repeated.stage).toBe("complete");
    expect(state.resolveSource).not.toHaveBeenCalled();
  });
});

it("counts unread and queued podcast jobs, excluding read, deleted, failed and other accounts", async () => {
  const jobs = await import("./jobs.js");
  const ids: string[] = [];
  for (const [index, flags] of [
    {},
    { readAt: "2026-09-01T12:00:00Z" },
    { deletedAt: "2026-09-01T12:00:00Z" },
    { stage: "failed" as const },
  ].entries()) {
    const id = `00000000-0000-4000-8000-00000000078${index}`;
    ids.push(id);
    const job = {
      ...input,
      id,
      stage: "complete",
      progress: 100,
      message: "Klaar",
      createdAt: "2026-09-01T10:00:00Z",
      updatedAt: "2026-09-01T10:00:00Z",
      ...flags,
    } satisfies Job;
    state.files.set(
      path.resolve("data/users/owner/jobs", `${id}.json`),
      JSON.stringify(job),
    );
  }
  await jobs.resumeIncompleteJobs(["owner"]);
  const queued = await jobs.createJob("owner", {
    ...input,
    sourceUrl: "https://www.youtube.com/watch?v=abcdefghijk",
  });
  ids.push(queued.id);

  expect(jobs.podcastOutstandingCount("owner", ids)).toBe(2);
  expect(jobs.podcastOutstandingCount("other", ids)).toBe(0);
});
