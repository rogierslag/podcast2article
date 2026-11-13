import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { translate } from "../src/shared/i18n.ts";
import { browserSource } from "./client-source.mjs";

const app = browserSource("public/app.ts");
const filter = app.slice(
  app.indexOf("function showTranscriptNoResults("),
  app.indexOf("\nfunction sourceClick("),
);
const clearHandler = app.slice(
  app.indexOf(
    'requiredElement("#clear-transcript-search", HTMLButtonElement).addEventListener',
  ),
  app.indexOf(
    'requiredElement("#toggle-transcript", HTMLButtonElement).addEventListener',
  ),
);

function setup(language = "nl") {
  const transcriptRows = [
    { text: "Ruimte voor aandacht.", speaker: "Sanne" },
    { text: "Rustig samenwerken.", speaker: "Joris" },
  ].map(({ text, speaker }) => ({
    text,
    searchableText: text.toLowerCase(),
    searchableSpeaker: speaker.toLowerCase(),
    element: { hidden: false },
    paragraph: {
      childElementCount: 0,
      replaceChildren() {},
    },
  }));
  let clear;
  const context = {
    transcriptRows,
    transcriptQuery: "",
    transcriptEmpty: { hidden: true },
    transcriptSearchStatus: { textContent: "" },
    transcriptSearch: {
      value: "",
      focus() {
        this.focused = true;
      },
    },
    requiredElement: () => ({
      addEventListener: (_event, callback) => {
        clear = callback;
      },
    }),
    HTMLButtonElement: class {},
    document: {
      createDocumentFragment: () => ({ append() {} }),
      createElement: () => ({}),
    },
    t: (key) => translate(language, key),
  };
  runInNewContext(filter + clearHandler, context);
  return { ...context, clear };
}

test("unmatched search explains the empty result and clearing restores all segments", () => {
  const {
    filterTranscript,
    transcriptEmpty,
    transcriptRows,
    transcriptSearchStatus,
  } = setup();

  filterTranscript("vakantie");

  assert.equal(transcriptEmpty.hidden, false);
  assert.equal(transcriptSearchStatus.textContent, "Geen resultaten");
  assert.ok(transcriptRows.every(({ element }) => element.hidden));

  filterTranscript("");

  assert.equal(transcriptEmpty.hidden, true);
  assert.equal(transcriptSearchStatus.textContent, "");
  assert.ok(transcriptRows.every(({ element }) => !element.hidden));
});

test("speaker and text matching ignore case and surrounding whitespace", () => {
  const { filterTranscript, transcriptRows } = setup();

  for (const query of [" SANNE ", "AANDACHT"]) {
    filterTranscript(query);

    assert.deepEqual(
      transcriptRows.map(({ element }) => element.hidden),
      [false, true],
    );
  }
  filterTranscript("   ");

  assert.ok(transcriptRows.every(({ element }) => !element.hidden));
});

test("the empty state uses the reader's language", () => {
  const { filterTranscript, transcriptSearchStatus } = setup("en");

  filterTranscript("vacation");

  assert.equal(transcriptSearchStatus.textContent, "No results");
});

test("the clear action empties the field, restores segments and returns focus to search", () => {
  const { clear, filterTranscript, transcriptEmpty, transcriptSearch } =
    setup();
  transcriptSearch.value = "vakantie";
  filterTranscript(transcriptSearch.value);

  clear();

  assert.equal(transcriptSearch.value, "");
  assert.equal(transcriptSearch.focused, true);
  assert.equal(transcriptEmpty.hidden, true);
});
