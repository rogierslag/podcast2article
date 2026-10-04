import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";
import { readWebVitals, summarizeWebVitals } from "./web-vitals-summary.js";
import type { WebVitalReport } from "./web-vitals.js";

const report = {
  name: "LCP",
  value: 100,
  id: "v6-test",
  sequence: 1,
  navigationType: "navigate",
  page: "article",
  layout: "wide",
  release: null,
} satisfies WebVitalReport;

test("p75 uses the latest metric snapshot, with separate release and layout groups", () => {
  const reports: WebVitalReport[] = [100, 200, 300, 400].map(
    (value, index) => ({
      ...report,
      id: `v6-${index}`,
      value,
    }),
  );
  reports.push(
    { ...report, id: "v6-0", value: 500, sequence: 2 },
    { ...report, id: "v6-0", value: 50 },
  );
  reports.push({
    ...report,
    id: "v6-other",
    layout: "narrow",
    release: "a".repeat(40),
  });

  const summary = summarizeWebVitals(reports);

  assert.equal(summary.length, 2);
  assert.deepEqual(
    summary.find((group) => group.layout === "wide"),
    {
      page: "article",
      layout: "wide",
      release: null,
      navigationType: "navigate",
      name: "LCP",
      samples: 4,
      p75: 400,
    },
  );
  assert.equal(
    summary.some((group) => group.name === "INP"),
    false,
  );
});

test("reading persisted files counts malformed rows and ignores unrelated files", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "web-vitals-summary-"));
  try {
    await writeFile(
      path.join(directory, "2026-10-04.jsonl"),
      JSON.stringify({ ...report, receivedAt: "2026-10-04T12:00:00Z" }) +
        '\n{"truncated":',
    );
    await writeFile(path.join(directory, "notes.txt"), "unrelated");

    const result = await readWebVitals(directory);

    assert.equal(result.invalidLines, 1);
    assert.deepEqual(result.reports, [report]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
