import { createHash } from "node:crypto";
import type { ShareAnalytics } from "../types.js";

const visitLifetimeMs = 24 * 60 * 60 * 1000;
const maximumRecentVisits = 256;

/** Bounded, anonymous deduplication; totals survive expiration of visit receipts. */
export function recordShareEvent(
  previous: ShareAnalytics | undefined,
  visitId: string,
  event: "load" | "read",
  now = Date.now(),
): ShareAnalytics | undefined {
  const digest = createHash("sha256").update(visitId).digest("hex");
  const recentVisits = (previous?.recentVisits ?? [])
    .filter((visit) => now - visit.loadedAt < visitLifetimeMs)
    .map((visit) => ({ ...visit }));
  const visit = recentVisits.find((visit) => visit.digest === digest);
  const result: ShareAnalytics = {
    loads: previous?.loads ?? 0,
    reads: previous?.reads ?? 0,
    lastLoadedAt: previous?.lastLoadedAt,
    lastReadAt: previous?.lastReadAt,
    recentVisits,
  };
  if (event === "load") {
    if (visit) {
      return previous;
    }
    result.loads += 1;
    result.lastLoadedAt = new Date(now).toISOString();
    recentVisits.push({ digest, loadedAt: now, read: false });
    result.recentVisits = recentVisits.slice(-maximumRecentVisits);
    return result;
  }
  if (!visit || now - visit.loadedAt < 30_000) {
    return undefined;
  }
  if (visit.read) {
    return previous;
  }
  visit.read = true;
  result.reads += 1;
  result.lastReadAt = new Date(now).toISOString();
  return result;
}
