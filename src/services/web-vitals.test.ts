import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import {
  WebVitalsCapacityError,
  WebVitalsStore,
  webVitalSchema,
  type WebVitalReport,
} from "./web-vitals.js";

const report = {
  name: "CLS",
  value: 0.134,
  id: "v6-test-123",
  sequence: 1,
  navigationType: "navigate",
  page: "shared-article",
  layout: "narrow",
  release: "a".repeat(40),
} satisfies WebVitalReport;

it("accepts bounded measurements and rejects identifiers, URLs and attribution", () => {
  expect(webVitalSchema.safeParse(report).success).toBe(true);
  for (const changes of [
    { value: -1 },
    { value: Infinity },
    { value: 101 },
    { page: "/s/private-token" },
    { id: "../../outside" },
    { release: "bad-release" },
    { sequence: 0 },
    { username: "private-owner" },
    { entries: [{ url: "https://private.example" }] },
    { navigationURL: "https://reads.example/s/private-token" },
  ]) {
    expect(webVitalSchema.safeParse({ ...report, ...changes }).success).toBe(
      false,
    );
  }
});

it("serializes concurrent writes and preserves measurements across restart", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "web-vitals-"));
  const now = () => new Date("2026-10-04T12:00:00.000Z");
  try {
    const store = new WebVitalsStore({ directory, now });

    await Promise.all([
      store.record(report),
      store.record({ ...report, sequence: 2, value: 0.15 }),
    ]);
    await new WebVitalsStore({ directory, now }).record({
      ...report,
      name: "LCP",
      value: 1000,
    });

    const lines = (
      await readFile(path.join(directory, "2026-10-04.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(lines).toHaveLength(3);
    expect(lines[0]).toEqual({ ...report, receivedAt: now().toISOString() });
    expect(lines[1].sequence).toBe(2);
    expect(lines[2].name).toBe("LCP");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("prunes only expired daily files and rotates into the next UTC day", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "web-vitals-"));
  let current = new Date("2026-10-04T23:59:00Z");
  try {
    for (const filename of [
      "2026-09-04.jsonl",
      "2026-09-05.jsonl",
      "notes.txt",
    ]) {
      await writeFile(path.join(directory, filename), "preserve or prune");
    }
    const store = new WebVitalsStore({ directory, now: () => current });

    await store.record(report);
    expect(await readdir(directory)).toEqual([
      "2026-09-05.jsonl",
      "2026-10-04.jsonl",
      "notes.txt",
    ]);
    current = new Date("2026-10-05T00:01:00Z");
    await store.record(report);

    expect(await readdir(directory)).toEqual([
      "2026-10-04.jsonl",
      "2026-10-05.jsonl",
      "notes.txt",
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("bounds daily storage without breaking admission on the next day", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "web-vitals-"));
  let current = new Date("2026-10-04T12:00:00Z");
  try {
    const store = new WebVitalsStore({
      directory,
      now: () => current,
      maxDailyBytes: Buffer.byteLength(
        JSON.stringify({ ...report, receivedAt: current.toISOString() }) + "\n",
      ),
    });
    await store.record(report);

    await expect(store.record(report)).rejects.toBeInstanceOf(
      WebVitalsCapacityError,
    );
    current = new Date("2026-10-05T12:00:00Z");
    await expect(store.record(report)).resolves.toBeUndefined();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("recovers after a persistence failure and exposes it to the caller", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "web-vitals-"));
  const directory = path.join(root, "blocked");
  try {
    await writeFile(directory, "not a directory");
    const store = new WebVitalsStore({ directory });

    await expect(store.record(report)).rejects.toThrow();
    await rm(directory);
    await mkdir(directory);
    await expect(store.record(report)).resolves.toBeUndefined();
    await store.flush();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("keeps a new measurement separate from a crash-truncated append", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "web-vitals-"));
  const now = () => new Date("2026-10-04T12:00:00Z");
  const file = path.join(directory, "2026-10-04.jsonl");
  try {
    await writeFile(file, '{"truncated":');

    await new WebVitalsStore({ directory, now }).record(report);

    const lines = (await readFile(file, "utf8")).trim().split("\n");
    expect(lines[0]).toBe('{"truncated":');
    expect(JSON.parse(lines[1] ?? "")).toEqual({
      ...report,
      receivedAt: now().toISOString(),
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
