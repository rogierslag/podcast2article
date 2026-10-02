import { describe, expect, it } from "vitest";
import { articleSpeechPassages } from "../../public/article-speech-text.js";
import type { Article } from "../types.js";

const article = {
  title: "A title.",
  dek: "An introduction.",
  styleNote: "Do not narrate style metadata.",
  readingTimeMinutes: 1,
  sections: [
    {
      heading: "First section.",
      paragraphs: [
        {
          kind: "quote",
          text: "A direct quote!",
          sources: ["private-source-id"],
        },
      ],
    },
  ],
  takeaways: [{ text: "A takeaway?", sources: [] }],
} satisfies Article;

describe("article narration text", () => {
  it("reads editorial content in order without source identifiers or metadata", () => {
    expect(articleSpeechPassages(article)).toEqual([
      "A title.",
      "An introduction.",
      "First section.",
      "A direct quote!",
      "A takeaway?",
    ]);
  });
  it("bounds long sentences and unbroken text without losing words or splitting surrogate pairs", () => {
    const text = `${"longword ".repeat(100)}${"🌳".repeat(180)}`;
    const passages = articleSpeechPassages({
      ...article,
      title: text,
      dek: "",
      sections: [],
      takeaways: [],
    });

    expect(passages.every((passage) => Array.from(passage).length <= 160)).toBe(
      true,
    );
    expect(passages.join("").replace(/\s/g, "")).toBe(text.replace(/\s/g, ""));
  });
});
