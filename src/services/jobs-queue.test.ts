import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "../types.js";

const state = vi.hoisted(() => ({
  files: new Map<string, string>(),
  resolveSource: vi.fn(),
  writeFile: vi.fn(),
}));
vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof import("node:fs/promises")>()),
  mkdir: vi.fn(),
  rm: vi.fn(),
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
vi.mock("../lib/logger.js", () => ({ jobLog: vi.fn(), jobError: vi.fn() }));
const input = {
  sourceUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  language: "auto",
  articleLength: "standard",
} satisfies Pick<Job, "sourceUrl" | "language" | "articleLength">;

beforeEach(() => {
  vi.resetModules();
  state.files.clear();
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

describe("processing reservations and serial queue (PR 17 and lost-video investigation)", () => {
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

  it("keeps accounts isolated while running only one source at a time, then advances after failure", async () => {
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
      expect(state.resolveSource).toHaveBeenCalledTimes(1),
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
      expect(state.resolveSource).toHaveBeenCalledTimes(1),
    );

    await jobs.shutdownJobs();
    vi.resetModules();
    state.resolveSource.mockClear();
    const restarted = await import("./jobs.js");
    await restarted.resumeIncompleteJobs(["owner", "other"]);
    await vi.waitFor(() =>
      expect(state.resolveSource).toHaveBeenCalledTimes(1),
    );

    expect(restarted.listProcessingJobs("owner").map((job) => job.id)).toEqual([
      first.id,
    ]);
    expect(restarted.listProcessingJobs("other")).toMatchObject([
      { id: second.id, stage: "queued" },
    ]);
  });
});
