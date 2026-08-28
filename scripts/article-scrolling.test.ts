import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { translate } from "../public/i18n.js";

// Run the reading controller without loading jobs or starting network requests.
// Native iOS status-bar gestures and safe-area painting require simulator tests.
const controller = readFileSync("public/app.js", "utf8")
  .replace(/^import\s*\{[^}]*\}\s*from "\.\/localize\.js";\s*/, "")
  .split('localizedFetch("/api/auth")')[0];

function setupReadingController(
  viewportHeight = 844,
  reducedMotion = false,
  safeAreaTop = 0,
) {
  vi.useFakeTimers();
  const listeners = new Map<string, (event?: object) => void>();
  const frames: Array<() => void> = [];
  const attributes = new Map<string, string>();
  const progressValue = { style: { transform: "" } };
  const hidden = new Set<string>();
  const fetch = vi.fn(async () => ({ ok: true, status: 200 }));
  const window = {
    fetch,
    scrollY: 0,
    innerHeight: viewportHeight,
    scrollTo: vi.fn(),
    addEventListener: (event: string, callback: (event?: object) => void) =>
      listeners.set(event, callback),
  };
  const article = {
    offsetHeight: 3000,
    getBoundingClientRect: () => ({ top: 600 - window.scrollY }),
  };
  const headings = [900, 1700, 2500].map((top) => ({
    textContent: `Section ${top}`,
    getBoundingClientRect: () => ({ top: top - window.scrollY }),
  }));
  const elements = new Map<string, unknown>([
    ["#article", article],
    [
      "#article-reading-progress",
      {
        classList: { contains: () => false },
        querySelector: () => progressValue,
        setAttribute: (name: string, value: string) =>
          attributes.set(name, value),
      },
    ],
    ["#result-view", { classList: { contains: () => false } }],
    [
      "#continue-reading",
      {
        classList: {
          add: (name: string) => hidden.add(name),
          remove: (name: string) => hidden.delete(name),
        },
        addEventListener: (event: string, callback: () => void) =>
          listeners.set(`continue:${event}`, callback),
      },
    ],
    ["#continue-reading-heading", { textContent: "" }],
  ]);
  const context = createContext({
    window,
    localizedFetch: window.fetch,
    t: (key: string, values?: Record<string, string | number>) =>
      translate("nl", key, values),
    document: {
      querySelector: (selector: string) => elements.get(selector),
      querySelectorAll: () => headings,
    },
    requestAnimationFrame: (callback: () => void) => {
      frames.push(callback);
      return frames.length;
    },
    clearTimeout,
    setTimeout,
    matchMedia: () => ({ matches: reducedMotion }),
    getComputedStyle: () => ({ scrollMarginTop: `${30 + safeAreaTop}px` }),
    performance: { now: () => 0 },
  });
  runInContext(controller ?? "", context);
  return {
    window,
    fetch,
    article,
    attributes,
    progressValue,
    listeners,
    frames,
    scroll: (top: number) => {
      window.scrollY = top;
      listeners.get("scroll")?.();
      frames.shift()?.();
    },
    run: (source: string) => runInContext(source, context),
  };
}

afterEach(() => vi.useRealTimers());

describe("article native scrolling", () => {
  it.each(["touchmove", "wheel", "keydown"])(
    "saves the settled reading section after %s input",
    async (input) => {
      const reader = setupReadingController();
      reader.run('currentJob = { id: "reading-test" }');

      reader.listeners.get(input)?.({
        deltaY: 400,
        key: "PageDown",
        target: { closest: () => null },
      });
      reader.scroll(1450);
      reader.listeners.get("scrollend")?.();
      await reader.run("flushReadingPosition()");

      expect(reader.fetch).toHaveBeenCalledWith(
        "/api/jobs/reading-test/reading-position",
        expect.objectContaining({ body: '{"sectionIndex":1}' }),
      );
    },
  );

  it("keeps the saved section while a native jump passes earlier sections", async () => {
    const reader = setupReadingController();
    reader.run(
      'currentJob = { id: "reading-test" }; showContinueReading({ sectionIndex: 2 })',
    );
    reader.window.scrollY = 2500;

    for (const position of [1700, 900, 0]) {
      reader.scroll(position);
      await vi.advanceTimersByTimeAsync(800);
    }
    reader.listeners.get("pagehide")?.();

    expect(reader.fetch).not.toHaveBeenCalled();
    expect(reader.attributes.get("aria-valuenow")).toBe("0");
  });

  it("discards intermediate sections when a gesture ends at the navigation", async () => {
    const reader = setupReadingController();
    reader.run(
      'currentJob = { id: "reading-test" }; showContinueReading({ sectionIndex: 2 })',
    );
    reader.window.scrollY = 2500;

    reader.listeners.get("touchmove")?.({});
    reader.scroll(1700);
    reader.scroll(900);
    reader.scroll(0);
    reader.listeners.get("scrollend")?.();
    await reader.run("flushReadingPosition()");

    expect(reader.fetch).not.toHaveBeenCalled();
  });

  it("still saves deliberate backward reading", async () => {
    const reader = setupReadingController();
    reader.run(
      'currentJob = { id: "reading-test" }; showContinueReading({ sectionIndex: 2 })',
    );
    reader.window.scrollY = 2500;

    reader.listeners.get("touchmove")?.({});
    reader.scroll(900);
    reader.listeners.get("scrollend")?.();
    await reader.run("flushReadingPosition()");

    expect(reader.fetch).toHaveBeenCalledWith(
      "/api/jobs/reading-test/reading-position",
      expect.objectContaining({ body: '{"sectionIndex":0}' }),
    );
  });

  it("ends momentum tracking without scrollend and ignores a later native jump", async () => {
    const reader = setupReadingController();
    reader.run('currentJob = { id: "reading-test" }');

    reader.listeners.get("touchmove")?.({});
    reader.scroll(900);
    await vi.advanceTimersByTimeAsync(100);
    reader.scroll(1700);
    await vi.advanceTimersByTimeAsync(200);
    reader.scroll(900);
    reader.scroll(0);
    reader.listeners.get("pagehide")?.();

    expect(reader.fetch).toHaveBeenCalledExactlyOnceWith(
      "/api/jobs/reading-test/reading-position",
      expect.objectContaining({ body: '{"sectionIndex":1}', keepalive: true }),
    );
  });

  it("flushes the natural reading position when leaving before scrollend", () => {
    const reader = setupReadingController();
    reader.run('currentJob = { id: "reading-test" }');

    reader.listeners.get("touchmove")?.({});
    reader.scroll(1700);
    reader.listeners.get("pagehide")?.();

    expect(reader.fetch).toHaveBeenCalledWith(
      "/api/jobs/reading-test/reading-position",
      expect.objectContaining({ body: '{"sectionIndex":1}', keepalive: true }),
    );
  });

  it.each(["Home", "End", "Enter"])(
    "does not treat %s as reading input",
    async (key) => {
      const reader = setupReadingController();
      reader.run('currentJob = { id: "reading-test" }');

      reader.listeners.get("keydown")?.({
        key,
        target: { closest: () => null },
      });
      reader.scroll(1700);
      reader.listeners.get("scrollend")?.();
      await reader.run("flushReadingPosition()");

      expect(reader.fetch).not.toHaveBeenCalled();
    },
  );

  it("does not treat keys in an interactive control as reading input", async () => {
    const reader = setupReadingController();
    reader.run('currentJob = { id: "reading-test" }');

    reader.listeners.get("keydown")?.({
      key: "ArrowDown",
      target: { closest: () => ({}) },
    });
    reader.scroll(1700);
    reader.listeners.get("scrollend")?.();
    await reader.run("flushReadingPosition()");

    expect(reader.fetch).not.toHaveBeenCalled();
  });

  it.each([844, 1000])(
    "tracks progress from the document at viewport height %i",
    (height) => {
      const reader = setupReadingController(height);
      const end = 600 + reader.article.offsetHeight - height;

      for (const [scrollTop, percentage] of [
        [0, 0],
        [600, 0],
        [600 + (end - 600) / 2, 50],
        [end, 100],
        [end + 400, 100],
      ]) {
        reader.window.scrollY = scrollTop;
        reader.run("updateArticleReadingProgress()");

        expect(reader.attributes.get("aria-valuenow")).toBe(String(percentage));
        expect(reader.progressValue.style.transform).toBe(
          `scaleX(${percentage / 100})`,
        );
      }
    },
  );

  it("updates progress when the native document scrolls", () => {
    const reader = setupReadingController();
    reader.window.scrollY = 2000;

    reader.listeners.get("scroll")?.();
    reader.frames.shift()?.();

    expect(Number(reader.attributes.get("aria-valuenow"))).toBeGreaterThan(0);
  });

  it("recalculates completion when the viewport grows", () => {
    const reader = setupReadingController();
    reader.window.scrollY = 2600;
    reader.run("updateArticleReadingProgress()");
    expect(Number(reader.attributes.get("aria-valuenow"))).toBeLessThan(100);

    reader.window.innerHeight = 1000;
    reader.listeners.get("resize")?.();
    reader.frames.shift()?.();

    expect(reader.attributes.get("aria-valuenow")).toBe("100");
  });

  it("handles an article shorter than the viewport without dividing by zero", () => {
    const reader = setupReadingController();
    reader.article.offsetHeight = 400;

    reader.window.scrollY = 599;
    reader.run("updateArticleReadingProgress()");
    expect(reader.attributes.get("aria-valuenow")).toBe("0");
    reader.window.scrollY = 600;
    reader.run("updateArticleReadingProgress()");

    expect(reader.attributes.get("aria-valuenow")).toBe("100");
  });

  it("resets the document immediately when opening an article", () => {
    const reader = setupReadingController();
    reader.window.scrollY = 2000;

    reader.run("resetArticleScroll()");

    expect(reader.window.scrollTo).toHaveBeenCalledWith({
      top: 0,
      behavior: "instant",
    });
  });

  it.each([false, true])(
    "resumes at the document heading with reduced motion %s",
    (reducedMotion) => {
      const reader = setupReadingController(844, reducedMotion);
      reader.window.scrollY = 400;
      reader.run("showContinueReading({ sectionIndex: 1 })");

      reader.listeners.get("continue:click")?.();

      expect(reader.window.scrollTo).toHaveBeenCalledWith({
        top: 1670,
        behavior: reducedMotion ? "instant" : "smooth",
      });
    },
  );

  it("finds the reading section from its current viewport position", () => {
    const reader = setupReadingController();
    reader.window.scrollY = 1450;

    const section = reader.run("visibleReadingSectionIndex()");

    expect(section).toBe(1);
  });

  it("keeps the resumed heading below the iOS safe area", () => {
    const reader = setupReadingController(844, false, 62);
    reader.window.scrollY = 400;
    reader.run("showContinueReading({ sectionIndex: 1 })");

    reader.listeners.get("continue:click")?.();

    expect(reader.window.scrollTo).toHaveBeenCalledWith({
      top: 1608,
      behavior: "smooth",
    });
  });
});
