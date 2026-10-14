import assert from "node:assert/strict";
import { test } from "node:test";
import {
  renderArticle,
  renderContents,
  renderSourceAttribution,
} from "../public/article-render.ts";
import { articleHash } from "../public/article-location.ts";
import { translate } from "../src/shared/i18n.ts";

const article = {
  title: "Room for attention",
  dek: "A conversation about collaboration.",
  readingTimeMinutes: 3,
  styleNote: "Direct.",
  sections: [
    {
      heading: "A repeated heading",
      paragraphs: [
        {
          text: "Make room to think.",
          sources: ["first", "missing", "second"],
        },
        {
          kind: "quote",
          text: "More calm creates room for attention.",
          sources: ["first"],
        },
      ],
    },
    {
      heading: "A repeated heading",
      paragraphs: [{ kind: "paragraph", text: "Work together.", sources: [] }],
    },
  ],
  takeaways: [{ text: "Choose attention.", sources: ["second"] }],
};
const sources = [
  { id: "first", start: 65.9 },
  { id: "second", start: 3661 },
];

for (const language of ["nl", "en"]) {
  for (const citationMode of ["source", "time"]) {
    test(`${language}/${citationMode}: citations preserve order, labels and reader-specific targets`, () => {
      const markup = renderArticle(article, sources, {
        language,
        citationMode,
        byline: "Three minutes",
      });
      const buttons = markup.match(/<button\b[\s\S]*?<\/button>/g);

      assert.equal(buttons.length, 4);
      const target =
        citationMode === "source" ? 'data-source="first"' : 'data-time="65.9"';
      assert.ok(buttons[0].includes(target));
      assert.ok(
        buttons[0].includes(
          `aria-label="${translate(language, citationMode === "source" ? "source.jump" : "source.listen", { time: "1:05" })}"`,
        ),
      );
      assert.ok(buttons[1].includes("1:01:01"));
      assert.ok(
        !markup.includes(
          citationMode === "source" ? "data-time=" : "data-source=",
        ),
      );
      assert.ok(markup.includes("<blockquote>"));
      assert.ok(markup.includes("Make room to think."));
      assert.ok(markup.includes(translate(language, "article.takeaways")));
      assert.ok(!markup.includes('data-source="missing"'));
    });
  }
}

test("restored articles without source media retain their prose, quotes and takeaways", () => {
  const markup = renderArticle(article, [], {
    language: "en",
    citationMode: "source",
    byline: "Restored article",
  });

  assert.ok(markup.includes("Room for attention"));
  assert.ok(markup.includes("<blockquote>"));
  assert.ok(markup.includes("Choose attention."));
  assert.ok(!markup.includes("<button"));
  assert.ok(!markup.includes('class="sources"'));
});

test("duplicate source identities keep the first timestamp", () => {
  const markup = renderArticle(
    article,
    [...sources, { id: "first", start: 99 }],
    { language: "en", citationMode: "time", byline: "Reading" },
  );

  assert.ok(markup.includes('data-time="65.9"'));
  assert.ok(!markup.includes('data-time="99"'));
});

test("untrusted article text, bylines and citation identities remain escaped", () => {
  const text = '<img src=x onerror="alert(1)"> & attention';
  const id = 'source" onclick="alert(1)';
  const hostile = {
    ...article,
    title: text,
    dek: text,
    sections: [
      { heading: text, paragraphs: [{ kind: "quote", text, sources: [id] }] },
    ],
    takeaways: [{ text, sources: [id] }],
  };

  const markup = renderArticle(hostile, [{ id, start: 5 }], {
    language: "en",
    citationMode: "source",
    byline: text,
  });

  assert.ok(!markup.includes("<img"));
  assert.ok(!markup.includes(' onclick="'));
  assert.ok(markup.includes("&lt;img"));
  assert.ok(
    markup.includes('data-source="source&quot; onclick=&quot;alert(1)"'),
  );
});

test("contents keep matching, distinct heading identities and each reader's route", () => {
  const owner = renderContents(article, (id) => articleHash("article-id", id));
  const shared = renderContents(article, (id) => `#${id}`);
  const body = renderArticle(article, sources, {
    language: "en",
    citationMode: "time",
    byline: "Reading",
  });

  for (const id of [
    "section-0-a-repeated-heading",
    "section-1-a-repeated-heading",
  ]) {
    assert.ok(body.includes(`id="${id}"`));
    assert.ok(owner.includes(`href="#job=article-id&amp;section=${id}"`));
    assert.ok(shared.includes(`href="#${id}"`));
  }
  const escaped = renderContents(
    { ...article, sections: [{ heading: "<unsafe>", paragraphs: [] }] },
    () => '#" onclick="bad',
  );
  assert.ok(escaped.includes("&lt;unsafe&gt;"));
  assert.ok(!escaped.includes(' onclick="'));
});

for (const language of ["nl", "en"]) {
  test(`${language}: source attribution preserves each provider's link and optional metadata`, () => {
    for (const [sourceType, key] of [
      ["spotify", "source.viewSpotify"],
      ["rss", "source.viewPodcast"],
      ["youtube", "source.viewYoutube"],
      ["fathom", "source.viewFathom"],
      ["google-drive", "source.viewDrive"],
    ]) {
      const markup = renderSourceAttribution(
        {
          sourceType,
          sourceUrl: "https://example.com/watch?a=1&b=2",
          sourceName: "The working week",
          title: "Attention",
          durationSeconds: 120,
          publishedAt: "2026-09-01",
          imageUrl: 'https://example.com/image?label="cover"',
        },
        language,
      );

      assert.ok(markup.includes(translate(language, key)));
      assert.ok(markup.includes("https://example.com/watch?a=1&amp;b=2"));
      assert.ok(markup.includes("&quot;cover&quot;"));
      assert.ok(markup.includes('target="_blank"'));
      assert.ok(markup.includes('rel="noreferrer"'));
    }
    const minimal = renderSourceAttribution(
      {
        sourceType: "rss",
        sourceUrl: "https://example.com",
        sourceName: "<publication>",
        title: "<title>",
      },
      language,
    );
    assert.ok(!minimal.includes("<img"));
    assert.ok(!minimal.includes(" · "));
    assert.ok(minimal.includes("&lt;publication&gt;"));
    assert.ok(minimal.includes("&lt;title&gt;"));
  });
}
