import * as z from "zod/mini";
import { describe, expect, it } from "vitest";
import {
  articleSummarySchema,
  jobSchema,
  responseData,
  sharedArticleSchema,
} from "./api.js";

describe("browser API boundaries", () => {
  it("rejects malformed collection data before it can replace the reading library", async () => {
    const response = Response.json([
      { id: "article", title: "A conversation", readingTimeMinutes: "five" },
    ]);

    await expect(
      responseData(response, z.array(articleSummarySchema)),
    ).rejects.toThrow();
  });

  it("preserves partial processing jobs without requiring a completed article", () => {
    const job = {
      id: "processing",
      progress: 25,
      message: "Downloading",
      stage: "downloading",
    };

    expect(jobSchema.parse(job)).toEqual(job);
  });

  it("rejects incomplete shared articles instead of rendering broken source controls", () => {
    const shared = {
      article: { title: "A conversation" },
      sources: [{ id: "source", start: "five" }],
    };

    expect(sharedArticleSchema.safeParse(shared).success).toBe(false);
  });
});
