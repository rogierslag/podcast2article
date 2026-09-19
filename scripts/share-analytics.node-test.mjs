import assert from "node:assert/strict";
import { test } from "node:test";
import { createShareTracker } from "../public/share-analytics.js";

test("reading requires visible active time and the end, and sends only once", async () => {
  let now = 0;
  const events = [];
  const tracker = createShareTracker({
    now: () => now,
    send: async (event) => {
      events.push(event);
      return true;
    },
  });
  await tracker.tick({ visible: true, progress: 0 });
  for (let second = 0; second < 35; second += 1) {
    now += 1000;
    await tracker.tick({ visible: false, progress: 100 });
  }
  assert.deepEqual(events, ["load"]);
  tracker.activity();
  for (let second = 0; second < 35; second += 1) {
    now += 1000;
    await tracker.tick({ visible: true, progress: 50 });
  }
  assert.deepEqual(events, ["load"]);
  now += 1000;
  await tracker.tick({ visible: true, progress: 90 });
  await tracker.tick({ visible: true, progress: 100 });
  assert.deepEqual(events, ["load", "read"]);
});

test("failed monitoring retries without interrupting the reader", async () => {
  let attempts = 0;
  const tracker = createShareTracker({
    send: async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("offline");
      }
      return true;
    },
  });
  await tracker.tick({ visible: true, progress: 0 });
  await tracker.tick({ visible: true, progress: 0 });
  await tracker.tick({ visible: true, progress: 0 });
  assert.equal(attempts, 2);
});

test("idle and suspended tabs do not accumulate reading time", async () => {
  let now = 0;
  const events = [];
  const tracker = createShareTracker({
    now: () => now,
    send: async (event) => {
      events.push(event);
      return true;
    },
  });
  await tracker.tick({ visible: true, progress: 0 });
  now = 120_000;
  await tracker.tick({ visible: true, progress: 100 });
  for (let second = 0; second < 35; second += 1) {
    now += 1000;
    await tracker.tick({ visible: true, progress: 100 });
  }
  assert.deepEqual(events, ["load"]);
  tracker.activity();
  for (let second = 0; second < 30; second += 1) {
    now += 1000;
    await tracker.tick({ visible: true, progress: 100 });
  }
  assert.deepEqual(events, ["load", "read"]);
});
