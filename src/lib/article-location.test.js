import { describe, expect, it } from "vitest";
import {
  articleHash,
  readArticleLocation,
} from "../../public/article-location.js";

const jobId = "00000000-0000-4000-8000-000000000917";

describe("article locations", () => {
  it("keeps the article identity when linking to a section", () => {
    const hash = articleHash(jobId, "section-2-evidence");

    expect(readArticleLocation(hash)).toEqual({
      jobId,
      sectionId: "section-2-evidence",
      time: undefined,
    });
  });

  it("retains existing article and timestamp links", () => {
    expect(readArticleLocation(`#job=${jobId}&time=65.5`)).toEqual({
      jobId,
      sectionId: undefined,
      time: 65.5,
    });
    expect(readArticleLocation(articleHash(jobId)).jobId).toBe(jobId);
  });

  it.each(["-1", "NaN", "Infinity", "bad"])(
    "ignores invalid audio time %s",
    (time) => {
      expect(
        readArticleLocation(`#job=${jobId}&time=${time}`).time,
      ).toBeUndefined();
    },
  );

  it("encodes section identifiers without changing the article or adding parameters", () => {
    const sectionId = "section-1-title&job=other";

    expect(readArticleLocation(articleHash(jobId, sectionId))).toMatchObject({
      jobId,
      sectionId,
    });
  });

  it.each(["", "#section-1-title", "#job=../../other", "#job=missing"])(
    "does not treat %s as an article location",
    (hash) => {
      expect(readArticleLocation(hash).jobId).toBeUndefined();
    },
  );
});
