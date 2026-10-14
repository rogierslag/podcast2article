import { describe, expect, it } from "vitest";
import {
  prefillDestination,
  sourcePrefill,
  sharedSourcePrefill,
  seriesEpisodePrefill,
} from "../shared/source-prefill.js";

describe("incoming source links", () => {
  it("accepts only a bounded series episode reference", () => {
    const id = "00000000-0000-4000-8000-000000000771";
    expect(seriesEpisodePrefill(`${id}:episode-1`)).toEqual({
      subscriptionId: id,
      episodeKey: "episode-1",
    });
    for (const hash of [
      "other:one",
      `${id}:../private`,
      `${id}:javascript:alert(1)`,
      `${id}:${"a".repeat(201)}`,
    ]) {
      expect(seriesEpisodePrefill(hash)).toBeUndefined();
    }
  });
  it("keeps a validated episode reference through login without allowing an arbitrary destination", () => {
    const reference = "00000000-0000-4000-8000-000000000771:episode-1";
    const destination = prefillDestination(
      "https://example.com/episode",
      "/login",
      reference,
    );
    expect(
      new URL(destination, "https://reads.example").searchParams.get(
        "seriesEpisode",
      ),
    ).toBe(reference);
    expect(
      prefillDestination(undefined, "/login", "https://evil.example"),
    ).toBe("/login");
  });
  it("round-trips nested URL parameters through login without treating them as navigation", () => {
    const source =
      'https://open.spotify.com/episode/example?si=abc&title="test"#chapter';

    const destination = prefillDestination(source, "/login");

    expect(destination.startsWith("/login?sourceUrl=")).toBe(true);
    expect(
      new URL(destination, "https://reads.example").searchParams.get(
        "sourceUrl",
      ),
    ).toBe(source);
    expect(sourcePrefill(source)).toBe(source);
  });

  it.each([
    undefined,
    null,
    ["https://example.com"],
    {},
    "",
    "//evil.example",
    "javascript:alert(1)",
    "data:text/html,test",
    "https://user:password@example.com",
    "https://example.com/" + "x".repeat(500),
  ])("ignores unsafe or malformed input %j", (value) => {
    expect(sourcePrefill(value)).toBe("");
    expect(prefillDestination(value)).toBe("/");
  });
});

describe("Android shared links", () => {
  it("accepts a URL field and links in text or title", () => {
    const link =
      "https://open.spotify.com/episode/example?si=abc&context=share";

    expect(sharedSourcePrefill(link, "ignored", "ignored")).toBe(link);
    expect(
      sharedSourcePrefill(
        undefined,
        `Listen to this episode\n${link}`,
        undefined,
      ),
    ).toBe(link);
    expect(sharedSourcePrefill(undefined, undefined, link)).toBe(link);
  });

  it.each([
    "No link here",
    "javascript:alert(1)",
    "https://user:secret@example.com",
    "https://example.com/one https://example.com/two",
    "x".repeat(4001),
    ["https://example.com"],
  ])("ignores invalid, ambiguous or oversized shared text %j", (text) => {
    expect(sharedSourcePrefill(undefined, text, undefined)).toBe("");
  });
});
