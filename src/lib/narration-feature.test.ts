import { describe, expect, it } from "vitest";
import { narrationFeature } from "./narration-feature.js";

describe("browser narration rollout", () => {
  it("is off by default and the kill switch overrides an allowlist", () => {
    expect(narrationFeature({})("owner")).toBe(false);
    expect(
      narrationFeature({ BROWSER_NARRATION_USERS: "owner" })("owner"),
    ).toBe(false);
  });

  it("enables all accounts only when explicitly enabled without an allowlist", () => {
    const enabled = narrationFeature({ BROWSER_NARRATION_ENABLED: "true" });

    expect(enabled("owner")).toBe(true);
    expect(enabled("local")).toBe(true);
  });

  it("matches whole account names in a trimmed allowlist", () => {
    const enabled = narrationFeature({
      BROWSER_NARRATION_ENABLED: "true",
      BROWSER_NARRATION_USERS: " owner, tester, ",
    });

    expect(enabled("owner")).toBe(true);
    expect(enabled("tester")).toBe(true);
    expect(enabled("own")).toBe(false);
    expect(enabled("Owner")).toBe(false);
  });

  it("rejects ambiguous operator configuration", () => {
    expect(() =>
      narrationFeature({ BROWSER_NARRATION_ENABLED: "yes" }),
    ).toThrow("BROWSER_NARRATION_ENABLED must be true or false");
  });
});
