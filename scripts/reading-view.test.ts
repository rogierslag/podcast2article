import { describe, expect, it } from "vitest";
import { readingProgress, readingSection } from "../public/reading-view.ts";

describe("reading geometry", () => {
  it.each([844, 1000])(
    "clamps progress to article boundaries at viewport height %i",
    (height) => {
      const articleTop = 600;
      const articleHeight = 3000;
      const end = articleTop + articleHeight - height;

      expect(readingProgress(articleTop, articleHeight, 0, height)).toBe(0);
      expect(
        readingProgress(
          articleTop,
          articleHeight,
          (articleTop + end) / 2,
          height,
        ),
      ).toBe(50);
      expect(
        readingProgress(articleTop, articleHeight, end + 400, height),
      ).toBe(100);
    },
  );

  it("handles an article shorter than its viewport", () => {
    expect(readingProgress(600, 400, 599, 844)).toBe(0);
    expect(readingProgress(600, 400, 600, 844)).toBe(100);
  });

  it("uses the same section boundary for document and offset container viewports", () => {
    const positions = [320, 700, 1000];

    expect(readingSection(positions, 0, 1000)).toBe(0);
    expect(
      readingSection(
        positions.map((top) => top + 100),
        100,
        1000,
      ),
    ).toBe(0);
    expect(readingSection([321, 700], 0, 1000)).toBeUndefined();
    expect(readingSection([], 0, 844)).toBeUndefined();
  });
});
