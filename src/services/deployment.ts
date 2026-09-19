import { readFile } from "node:fs/promises";
import path from "node:path";

export async function deploymentFailed(
  statusFile = path.resolve("data/deployment-status.json"),
): Promise<boolean> {
  try {
    const status: unknown = JSON.parse(await readFile(statusFile, "utf8"));
    return (
      typeof status === "object" &&
      status !== null &&
      "failed" in status &&
      status.failed === true
    );
  } catch {
    // An absent or unreadable marker is not evidence of a failed deployment.
    return false;
  }
}

const deploymentWindowMs = 30 * 60 * 1000;
const freshnessWindowMs = 45 * 60 * 1000;

interface DeploymentHealth {
  status: "up_to_date" | "imminent" | "delayed" | "unknown";
  runningCommit: string | null;
  targetCommit: string | null;
  lastCheckedAt: string | null;
}

function commit(value: unknown): string | null {
  return typeof value === "string" && /^[0-9a-f]{40}$/.test(value)
    ? value
    : null;
}

function timestamp(value: unknown, now: number): number | null {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= now
    ? value
    : null;
}

export async function deploymentHealth(
  runningCommit: string | undefined,
  statusFile = path.resolve("data/deployment-status.json"),
  now = Date.now(),
): Promise<DeploymentHealth> {
  const result: DeploymentHealth = {
    status: "unknown",
    runningCommit: commit(runningCommit),
    targetCommit: null,
    lastCheckedAt: null,
  };
  try {
    const raw: unknown = JSON.parse(await readFile(statusFile, "utf8"));
    if (typeof raw !== "object" || raw === null) {
      return result;
    }
    const target = "targetCommit" in raw ? commit(raw.targetCommit) : null;
    const checked =
      "lastCheckedAt" in raw ? timestamp(raw.lastCheckedAt, now) : null;
    const observed =
      "targetObservedAt" in raw ? timestamp(raw.targetObservedAt, now) : null;
    result.targetCommit = target;
    result.lastCheckedAt =
      checked === null ? null : new Date(checked).toISOString();
    if (
      !result.runningCommit ||
      !target ||
      checked === null ||
      now - checked > freshnessWindowMs
    ) {
      return result;
    }
    if (result.runningCommit === target) {
      result.status = "up_to_date";
      return result;
    }
    if (
      !("phase" in raw) ||
      !("failed" in raw) ||
      typeof raw.failed !== "boolean" ||
      observed === null ||
      observed > checked
    ) {
      return result;
    }
    if (
      raw.failed ||
      raw.phase === "failed" ||
      now - observed >= deploymentWindowMs
    ) {
      result.status = "delayed";
    } else if (raw.phase === "deploying") {
      result.status = "imminent";
    } else if (raw.phase === "idle") {
      // The updater finished, but this process is still serving another release.
      result.status = "delayed";
    }
    return result;
  } catch {
    // Legacy, missing, or unreadable state cannot establish deployment freshness.
    return result;
  }
}
