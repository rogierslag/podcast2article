import { describe, expect, it } from "vitest";
import { formatArticleWordRange } from "../../public/article-length.js";
import { translate } from "../../public/i18n.js";

describe("article word ranges", () => {
  it.each([
    ["compact", "700-1000"],
    ["standard", "1100-1700"],
    ["long", "1800-2600"],
    ["unknown", "1100-1700"],
    ["", "1100-1700"],
    ["toString", "1100-1700"],
  ])("formats %s for the generation prompt", (length, expected) => {
    expect(formatArticleWordRange(length)).toBe(expected);
  });

  it.each([
    [
      "compact",
      "length.short",
      "Compact · 700–1.000 woorden",
      "Short · 700–1,000 words",
    ],
    [
      "standard",
      "length.standard",
      "Standaard · 1.100–1.700 woorden",
      "Standard · 1,100–1,700 words",
    ],
    [
      "long",
      "length.long",
      "Uitgebreid · 1.800–2.600 woorden",
      "Long · 1,800–2,600 words",
    ],
  ])(
    "shows the same %s targets in both UI languages",
    (length, key, dutch, english) => {
      const promptRange = formatArticleWordRange(length);

      expect(translate("nl", key)).toBe(dutch);
      expect(translate("en", key)).toBe(english);
      for (const locale of ["nl-NL", "en-GB"]) {
        const displayedRange = formatArticleWordRange(length, locale);
        expect(displayedRange.replace(/[.,]/g, "").replace("–", "-")).toBe(
          promptRange,
        );
        expect(translate(locale, key)).toContain(displayedRange);
      }
    },
  );
});
