import { describe, expect, it } from "vitest";
import { formatTimestamp, normalizeText, similarity } from "./format.js";

describe("format helpers", () => {
  it("formats short and long timestamps", () => {
    expect(formatTimestamp(65.9)).toBe("1:05");
    expect(formatTimestamp(3661)).toBe("1:01:01");
  });

  it("normalizes podcast boilerplate", () => {
    expect(normalizeText("Podcast: Dé Grote Aflevering!")).toBe("de grote");
  });

  it("scores matching episode titles above unrelated titles", () => {
    expect(
      similarity("Waarom steden werken", "Waarom steden echt werken"),
    ).toBeGreaterThan(similarity("Waarom steden werken", "Koken met aandacht"));
  });
});
