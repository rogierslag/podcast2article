import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { webVitalSchema, type WebVitalReport } from "./web-vitals.js";

interface WebVitalDimensions extends Pick<
  WebVitalReport,
  "page" | "layout" | "release" | "navigationType" | "name"
> {}

interface WebVitalSummary extends WebVitalDimensions {
  samples: number;
  p75: number;
}

interface WebVitalGroup extends WebVitalDimensions {
  values: number[];
}

export function summarizeWebVitals(
  reports: WebVitalReport[],
): WebVitalSummary[] {
  const latest = new Map<string, WebVitalReport>();
  for (const report of reports) {
    const key = `${report.name}:${report.id}`;
    const previous = latest.get(key);
    if (!previous || report.sequence >= previous.sequence) {
      latest.set(key, report);
    }
  }
  const groups = new Map<string, WebVitalGroup>();
  for (const report of latest.values()) {
    const { page, layout, release, navigationType, name } = report;
    const key = JSON.stringify([page, layout, release, navigationType, name]);
    let group = groups.get(key);
    if (!group) {
      group = { page, layout, release, navigationType, name, values: [] };
      groups.set(key, group);
    }
    group.values.push(report.value);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, group]) => {
      const { values, ...dimensions } = group;
      values.sort((left, right) => left - right);
      const p75 = values[Math.ceil(values.length * 0.75) - 1];
      if (p75 === undefined) {
        throw new Error("Empty Web Vitals group");
      }
      return {
        ...dimensions,
        samples: values.length,
        p75,
      };
    });
}

export async function readWebVitals(
  directory: string,
): Promise<{ reports: WebVitalReport[]; invalidLines: number }> {
  let filenames;
  try {
    filenames = await readdir(directory);
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return { reports: [], invalidLines: 0 };
    }
    throw error;
  }
  const reports: WebVitalReport[] = [];
  let invalidLines = 0;
  for (const filename of filenames
    .filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
    .sort()) {
    const lines = createInterface({
      input: createReadStream(path.join(directory, filename)),
      crlfDelay: Infinity,
    });
    for await (const line of lines) {
      try {
        const stored: unknown = JSON.parse(line);
        if (
          !stored ||
          typeof stored !== "object" ||
          !("receivedAt" in stored)
        ) {
          throw new Error("Invalid stored report");
        }
        const { receivedAt, ...report } = stored;
        if (
          typeof receivedAt !== "string" ||
          !Number.isFinite(Date.parse(receivedAt))
        ) {
          throw new Error("Invalid received timestamp");
        }
        reports.push(webVitalSchema.parse(report));
      } catch {
        // A crash can truncate an append; make discarded rows visible in the summary.
        invalidLines += 1;
      }
    }
  }
  return { reports, invalidLines };
}
