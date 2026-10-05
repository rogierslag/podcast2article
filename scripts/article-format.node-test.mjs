import assert from "node:assert/strict";
import { test } from "node:test";
import {
  articleSectionId,
  escapeHtml,
  formatTimestamp,
  html,
} from "../public/article-format.ts";

test("reader markup escapes source text without losing zero or empty values", () => {
  const source = `<img src="x" onerror='alert(1)'> & attention`;

  const markup = html`<p>${escapeHtml(source)} ${0}</p>`;

  assert.equal(
    markup,
    "<p>&lt;img src=&quot;x&quot; onerror=&#39;alert(1)&#39;&gt; &amp; attention 0</p>",
  );
  assert.equal(escapeHtml(), "");
});

test("source timestamps preserve whole-second seeking labels at minute and hour boundaries", () => {
  for (const [seconds, label] of [
    [-1, "0:00"],
    [0, "0:00"],
    [59.9, "0:59"],
    [60, "1:00"],
    [3599, "59:59"],
    [3600, "1:00:00"],
    [3661, "1:01:01"],
  ]) {
    assert.equal(formatTimestamp(seconds), label);
  }
});

test("section permalinks retain existing identifiers and distinguish repeated headings", () => {
  assert.equal(
    articleSectionId(" A new perspective! ", 0),
    "section-0-a-new-perspective",
  );
  assert.equal(
    articleSectionId(" A new perspective! ", 1),
    "section-1-a-new-perspective",
  );
  assert.equal(articleSectionId("Déjà vu", 2), "section-2-d-j-vu");
});
