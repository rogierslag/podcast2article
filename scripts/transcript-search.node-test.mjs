import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { translate } from "../public/i18n.js";

const app = readFileSync("public/app.js", "utf8");
const renderer = app.slice(
  app.indexOf("function renderTranscript("),
  app.indexOf("\nfunction sourceClick("),
);
const fixture = [
  { id: "t-1", start: 0, speaker: "Sanne", text: "Ruimte voor aandacht." },
  { id: "t-2", start: 30, speaker: "Joris", text: "Rustig samenwerken." },
];
function setup(language = "nl") {
  const elements = Object.fromEntries(
    [
      "transcript-segments",
      "transcript-empty",
      "transcript-search-status",
      "transcript-search",
    ].map((id) => [
      `#${id}`,
      {
        innerHTML: "",
        textContent: "",
        hidden: false,
        value: "",
        focus() {
          this.focused = true;
        },
      },
    ]),
  );
  const context = {
    $: (selector) => elements[selector],
    t: (key, values) => translate(language, key, values),
    time: String,
    escapeHtml: (value) =>
      String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll('"', "&quot;"),
    html: (strings, ...values) =>
      strings.reduce(
        (result, part, index) => result + part + (values[index] ?? ""),
        "",
      ),
  };
  runInNewContext(renderer + "; this.render = renderTranscript;", context);
  return { elements, context };
}
test("unmatched search explains the empty result and clearing restores all segments", () => {
  const { elements, context } = setup();

  context.render(fixture, "vakantie");

  assert.equal(elements["#transcript-empty"].hidden, false);
  assert.equal(
    elements["#transcript-search-status"].textContent,
    "Geen resultaten",
  );
  assert.equal(
    (elements["#transcript-segments"].innerHTML.match(/ hidden/g) ?? []).length,
    2,
  );

  context.render(fixture, "");

  assert.equal(elements["#transcript-empty"].hidden, true);
  assert.equal(elements["#transcript-search-status"].textContent, "");
  assert.equal(
    elements["#transcript-segments"].innerHTML.includes(" hidden"),
    false,
  );
});
test("speaker and text matching ignore case and surrounding whitespace", () => {
  const { elements, context } = setup();

  for (const query of [" SANNE ", "AANDACHT", "   "]) {
    context.render(fixture, query);

    assert.equal(elements["#transcript-empty"].hidden, true);
  }
});
test("English empty state is localized and search markup stays escaped", () => {
  const { elements, context } = setup("en");

  context.render(fixture, '<img src=x onerror="alert(1)">');

  assert.equal(elements["#transcript-search-status"].textContent, "No results");
  assert.equal(
    elements["#transcript-segments"].innerHTML.includes("<img"),
    false,
  );
});
test("the clear action empties the field, restores segments and returns focus to search", () => {
  const { elements, context } = setup();
  elements["#transcript-search"].value = "vakantie";
  context.currentJob = { transcript: fixture };
  let clear;
  elements["#clear-transcript-search"] = {
    addEventListener: (_event, callback) => {
      clear = callback;
    },
  };
  const handler = app.slice(
    app.indexOf('$("#clear-transcript-search").addEventListener'),
    app.indexOf('$("#toggle-transcript").addEventListener'),
  );
  runInNewContext(renderer + handler, context);

  clear();

  assert.equal(elements["#transcript-search"].value, "");
  assert.equal(elements["#transcript-search"].focused, true);
  assert.equal(elements["#transcript-empty"].hidden, true);
});
