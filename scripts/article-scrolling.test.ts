import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

// Run the reading controller without loading jobs or starting network requests.
// Native iOS status-bar gestures and safe-area painting require simulator tests.
const controller = readFileSync("public/app.js", "utf8").split(
  'fetch("/api/auth")',
)[0];

function setupReadingController(
  viewportHeight = 844,
  reducedMotion = false,
  safeAreaTop = 0,
) {
  const listeners = new Map<string, () => void>();
  const frames: Array<() => void> = [];
  const attributes = new Map<string, string>();
  const progressValue = { style: { transform: "" } };
  const hidden = new Set<string>();
  const window = {
    fetch: vi.fn(),
    scrollY: 0,
    innerHeight: viewportHeight,
    scrollTo: vi.fn(),
    addEventListener: (event: string, callback: () => void) =>
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
    document: {
      querySelector: (selector: string) => elements.get(selector),
      querySelectorAll: () => headings,
    },
    requestAnimationFrame: (callback: () => void) => {
      frames.push(callback);
      return frames.length;
    },
    clearTimeout: vi.fn(),
    setTimeout: vi.fn(),
    matchMedia: () => ({ matches: reducedMotion }),
    getComputedStyle: () => ({ scrollMarginTop: `${30 + safeAreaTop}px` }),
    performance: { now: () => 0 },
  });
  runInContext(controller ?? "", context);
  return {
    window,
    article,
    attributes,
    progressValue,
    listeners,
    frames,
    run: (source: string) => runInContext(source, context),
  };
}

describe("article native scrolling", () => {
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
