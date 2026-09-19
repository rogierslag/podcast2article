import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { deploymentFailed, deploymentHealth } from "./deployment.js";

let directory: string;
let statusFile: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "p2a-deployment-"));
  statusFile = path.join(directory, "status.json");
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});
it("does not infer a deployment failure from missing state", async () => {
  expect(await deploymentFailed(statusFile)).toBe(false);
});
it.each(["broken", "null", "true", '{"failed":"true"}', '{"failed":false}'])(
  "ignores invalid or healthy state: %s",
  async (status) => {
    await writeFile(statusFile, status);

    expect(await deploymentFailed(statusFile)).toBe(false);
  },
);
it("reads persisted failure and subsequent recovery", async () => {
  await writeFile(statusFile, '{"failed":true}');

  expect(await deploymentFailed(statusFile)).toBe(true);

  await writeFile(statusFile, '{"failed":false}');

  expect(await deploymentFailed(statusFile)).toBe(false);
});

const running = "a".repeat(40);
const target = "b".repeat(40);
const now = Date.UTC(2026, 8, 19, 15);
const minute = 60_000;
const fresh = {
  failed: false,
  phase: "deploying",
  targetCommit: target,
  lastCheckedAt: now,
  targetObservedAt: now,
};

it.each([
  ["matching release", { ...fresh, targetCommit: running }, "up_to_date"],
  ["active deployment", fresh, "imminent"],
  [
    "failed build or rollback",
    { ...fresh, failed: true, phase: "failed" },
    "delayed",
  ],
  [
    "deadline reached",
    { ...fresh, targetObservedAt: now - 30 * minute },
    "delayed",
  ],
  [
    "interrupted deployment",
    {
      ...fresh,
      lastCheckedAt: now - 31 * minute,
      targetObservedAt: now - 31 * minute,
    },
    "delayed",
  ],
  [
    "stale information",
    {
      ...fresh,
      lastCheckedAt: now - 46 * minute,
      targetObservedAt: now - 46 * minute,
    },
    "unknown",
  ],
  [
    "stale matching release",
    { ...fresh, targetCommit: running, lastCheckedAt: now - 46 * minute },
    "unknown",
  ],
  ["finished updater with old process", { ...fresh, phase: "idle" }, "delayed"],
  ["no proof of progress", { ...fresh, phase: "checking" }, "unknown"],
  ["future timestamp", { ...fresh, lastCheckedAt: now + 1 }, "unknown"],
  ["invalid target", { ...fresh, targetCommit: "secret" }, "unknown"],
  ["invalid observation", { ...fresh, targetObservedAt: now + 1 }, "unknown"],
  ["legacy marker", { failed: true }, "unknown"],
])("classifies %s", async (_name, state, expected) => {
  await writeFile(
    statusFile,
    JSON.stringify({ ...state, logs: "private", credentials: "private" }),
  );

  const result = await deploymentHealth(running, statusFile, now);

  expect(result.status).toBe(expected);
  expect(Object.keys(result).sort()).toEqual([
    "lastCheckedAt",
    "runningCommit",
    "status",
    "targetCommit",
  ]);
  expect(JSON.stringify(result)).not.toContain("private");
});

it("reports unknown for missing state or running commit", async () => {
  expect((await deploymentHealth(running, statusFile, now)).status).toBe(
    "unknown",
  );
  await writeFile(statusFile, JSON.stringify(fresh));

  expect((await deploymentHealth(undefined, statusFile, now)).status).toBe(
    "unknown",
  );
});

it("reconciles a missed update, rollback and recovery without changing the warning on reads", async () => {
  await writeFile(statusFile, JSON.stringify(fresh));
  expect((await deploymentHealth(running, statusFile, now)).status).toBe(
    "imminent",
  );
  await writeFile(
    statusFile,
    JSON.stringify({ ...fresh, failed: true, phase: "failed" }),
  );
  expect((await deploymentHealth(running, statusFile, now)).status).toBe(
    "delayed",
  );
  expect(await deploymentFailed(statusFile)).toBe(true);
  await writeFile(
    statusFile,
    JSON.stringify({ ...fresh, phase: "idle", failed: false }),
  );
  expect((await deploymentHealth(target, statusFile, now)).status).toBe(
    "up_to_date",
  );
  expect(await deploymentFailed(statusFile)).toBe(false);
});

it.each(["invalid JSON", "null", "[]", "true"])(
  "handles malformed persisted input %s",
  async (input) => {
    await writeFile(statusFile, input);

    expect((await deploymentHealth(running, statusFile, now)).status).toBe(
      "unknown",
    );
  },
);

it("keeps the deployment deadline and freshness boundary exact", async () => {
  await writeFile(statusFile, JSON.stringify(fresh));

  expect(
    (await deploymentHealth(running, statusFile, now + 30 * minute - 1)).status,
  ).toBe("imminent");
  expect(
    (await deploymentHealth(running, statusFile, now + 30 * minute)).status,
  ).toBe("delayed");
  expect(
    (await deploymentHealth(running, statusFile, now + 45 * minute)).status,
  ).toBe("delayed");
  expect(
    (await deploymentHealth(running, statusFile, now + 45 * minute + 1)).status,
  ).toBe("unknown");
});
