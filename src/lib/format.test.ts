import { describe, expect, it } from "vitest";
import { normalizeText, similarity } from "./format.js";

describe("format helpers", () => {
  it("normalizes podcast boilerplate", () => {
    expect(normalizeText("Podcast: Dé Grote Aflevering!")).toBe("de grote");
  });

  it("scores matching episode titles above unrelated titles", () => {
    expect(
      similarity("Waarom steden werken", "Waarom steden echt werken"),
    ).toBeGreaterThan(similarity("Waarom steden werken", "Koken met aandacht"));
  });
});
