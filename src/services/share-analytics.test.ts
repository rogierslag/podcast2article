import { describe, expect, it } from "vitest";
import { recordShareEvent } from "./share-analytics.js";

describe("shared article monitoring", () => {
  it("counts a load and qualified read once, retaining totals across serialization", () => {
    const loaded = recordShareEvent(undefined, "visit", "load", 0);
    const duplicate = recordShareEvent(loaded, "visit", "load", 1000);
    expect(duplicate?.loads).toBe(1);
    expect(
      recordShareEvent(duplicate, "visit", "read", 29_999),
    ).toBeUndefined();

    const read = recordShareEvent(duplicate, "visit", "read", 30_000);
    const restored = JSON.parse(JSON.stringify(read));

    expect(recordShareEvent(restored, "visit", "read", 31_000)?.reads).toBe(1);
    expect(recordShareEvent(restored, "second", "load", 32_000)?.loads).toBe(2);
    expect(JSON.stringify(read)).not.toContain('"digest":"visit"');
  });

  it("rejects reads without a recent load and bounds retained receipts", () => {
    expect(recordShareEvent(undefined, "visit", "read")).toBeUndefined();
    let state;
    for (let index = 0; index < 300; index += 1) {
      state = recordShareEvent(state, String(index), "load", index);
    }
    expect(state?.loads).toBe(300);
    expect(state?.recentVisits).toHaveLength(256);
    expect(recordShareEvent(state, "0", "read", 40_000)).toBeUndefined();
    expect(recordShareEvent(state, "299", "read", 86_400_300)).toBeUndefined();
  });
});
