import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createWebVitalsReporter,
  webVitalsPage,
} from "../public/web-vitals-reporting.js";

test("page classification discards source URLs, article IDs, and share tokens", () => {
  const classify = (templatePage, pathname, hash = "") =>
    webVitalsPage(
      { documentElement: { dataset: { vitalsPage: templatePage } } },
      { pathname, hash },
    );
  assert.equal(
    classify("owner", "/", "#job=private-id&sourceUrl=private-url"),
    "article",
  );
  assert.equal(classify("owner", "/articles"), "articles");
  assert.equal(classify("owner", "/"), "new-article");
  assert.equal(
    classify("shared-article", "/s/private-token"),
    "shared-article",
  );
  assert.equal(
    classify("shared-not-found", "/s/private-token"),
    "shared-not-found",
  );
});

test("reports contain only allowlisted measurements and order repeated snapshots", () => {
  const reports = [];
  const report = createWebVitalsReporter({
    page: "article",
    layout: "wide",
    release: null,
    send: (value) => reports.push(value),
  });
  const metric = {
    name: "INP",
    value: 100,
    id: "v6-test",
    navigationType: "navigate",
    entries: [{ target: "private text" }],
    navigationURL: "https://private.example",
    attribution: { url: "private-token" },
  };

  report(metric);
  report({ ...metric, value: 200 });

  assert.deepEqual(reports[0], {
    name: "INP",
    value: 100,
    id: "v6-test",
    sequence: 1,
    navigationType: "navigate",
    page: "article",
    layout: "wide",
    release: null,
  });
  assert.equal(reports[1].sequence, 2);
  assert.equal(reports[1].value, 200);
  assert.doesNotMatch(JSON.stringify(reports), /private/);
});
