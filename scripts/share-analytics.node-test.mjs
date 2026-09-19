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
  assert.deepEqual(events, []);
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
  let now = 0;
  const tracker = createShareTracker({
    now: () => now,
    send: async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("offline");
      }
      return true;
    },
  });
  for (let second = 0; second < 5; second += 1) {
    await tracker.tick({ visible: true, progress: 0 });
    now += 1000;
  }
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

test("opens require two consecutive visible seconds and exclude hidden or suspended time", async () => {
  let now = 0;
  const events = [];
  const tracker = createShareTracker({
    now: () => now,
    send: async (event) => {
      events.push(event);
      return true;
    },
  });
  const tick = async (time, visible = true) => {
    now = time;
    await tracker.tick({ visible, progress: 0 });
  };

  await tick(0);
  await tick(1999);
  assert.deepEqual(events, []);
  await tick(2000, false);
  await tick(10000, false);
  await tick(11000);
  await tick(12000);
  assert.deepEqual(events, []);
  // A long suspended interval resets the qualifying window as well.
  await tick(20000);
  await tick(21000);
  await tick(21999);
  assert.deepEqual(events, []);
  await tick(22000);
  await tick(23000);
  assert.deepEqual(events, ["load"]);
});
