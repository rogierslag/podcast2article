import { translate, type UiLanguage } from "../src/shared/i18n.ts";
import { requiredElement } from "./dom.ts";

export interface ReadingViewport {
  metrics(): { scrollTop: number; height: number; top: number };
  reset(): void;
  scrollToHeading(heading: HTMLElement, reducedMotion: boolean): void;
}

export function documentReadingViewport(): ReadingViewport {
  return {
    metrics: () => ({
      scrollTop: window.scrollY,
      height: window.innerHeight,
      top: 0,
    }),
    reset: () => window.scrollTo({ top: 0, behavior: "instant" }),
    scrollToHeading(heading, reducedMotion) {
      const offset =
        parseFloat(getComputedStyle(heading).scrollMarginTop) || 30;
      window.scrollTo({
        top: Math.max(
          0,
          heading.getBoundingClientRect().top + window.scrollY - offset,
        ),
        behavior: reducedMotion ? "instant" : "smooth",
      });
    },
  };
}

export function elementReadingViewport(surface: HTMLElement): ReadingViewport {
  return {
    metrics: () => ({
      scrollTop: surface.scrollTop,
      height: surface.clientHeight,
      top: surface.getBoundingClientRect().top,
    }),
    reset() {
      const previousBehavior = surface.style.scrollBehavior;
      surface.style.scrollBehavior = "auto";
      surface.scrollTop = 0;
      surface.style.scrollBehavior = previousBehavior;
    },
    scrollToHeading(heading, reducedMotion) {
      const top =
        heading.getBoundingClientRect().top -
        surface.getBoundingClientRect().top +
        surface.scrollTop -
        30;
      surface.scrollTo({
        top: Math.max(0, top),
        behavior: reducedMotion ? "auto" : "smooth",
      });
    },
  };
}

export function readingProgress(
  articleTop: number,
  articleHeight: number,
  scrollTop: number,
  viewportHeight: number,
): number {
  const end = Math.max(articleTop, articleTop + articleHeight - viewportHeight);
  const ratio =
    end === articleTop
      ? Number(scrollTop >= articleTop)
      : (scrollTop - articleTop) / (end - articleTop);
  return Math.round(Math.min(1, Math.max(0, ratio)) * 100);
}

export function readingSection(
  headingTops: readonly number[],
  viewportTop: number,
  viewportHeight: number,
): number | undefined {
  const readingLine = viewportTop + Math.min(viewportHeight * 0.42, 320);
  let sectionIndex: number | undefined;
  headingTops.forEach((top, index) => {
    if (top <= readingLine) {
      sectionIndex = index;
    }
  });
  return sectionIndex;
}

interface ReadingViewOptions {
  viewport: ReadingViewport;
  result: HTMLElement;
  language: UiLanguage;
  trackPosition(): void;
  beforeResume(): void;
  afterResume(): void;
}

/** Presentation owns frames and focus; each reader owns gesture detection and persistence. */
export function createReadingView(options: ReadingViewOptions) {
  const article = requiredElement("#article", HTMLElement);
  const progress = requiredElement("#article-reading-progress", HTMLElement);
  const progressValue = requiredElement(
    ".reading-progress-value",
    HTMLElement,
    progress,
  );
  const continueButton = requiredElement(
    "#continue-reading",
    HTMLButtonElement,
  );
  const continueHeading = requiredElement(
    "#continue-reading-heading",
    HTMLElement,
  );
  let progressFrame: number | undefined;
  let settlingFrame: number | undefined;
  let trackRequested = false;
  let continuationSectionIndex: number | undefined;
  let restoring = false;
  let highlightTimer: number | undefined;
  let highlightedHeading: HTMLElement | undefined;

  function headings() {
    return [...article.querySelectorAll<HTMLElement>("section > h2")];
  }

  function visibleSectionIndex() {
    const { top, height } = options.viewport.metrics();
    return readingSection(
      headings().map((heading) => heading.getBoundingClientRect().top),
      top,
      height,
    );
  }

  function hideContinuation() {
    continueButton.classList.add("hidden");
    continuationSectionIndex = undefined;
  }

  function showContinuation(position?: { sectionIndex: number }) {
    const heading = position ? headings()[position.sectionIndex] : undefined;
    if (!heading || !position) {
      hideContinuation();
      return;
    }
    continuationSectionIndex = position.sectionIndex;
    continueHeading.textContent = heading.textContent;
    continueButton.classList.remove("hidden");
  }

  function clearHighlight() {
    clearTimeout(highlightTimer);
    highlightedHeading?.classList.remove("resume-highlight");
    highlightedHeading = undefined;
  }

  function highlight(heading: HTMLElement) {
    clearHighlight();
    heading.classList.remove("resume-highlight");
    void heading.offsetWidth;
    heading.classList.add("resume-highlight");
    heading.setAttribute("tabindex", "-1");
    heading.focus({ preventScroll: true });
    highlightedHeading = heading;
    highlightTimer = setTimeout(clearHighlight, 2200);
  }

  function update() {
    progressFrame = undefined;
    const shouldTrack = trackRequested;
    trackRequested = false;
    if (
      progress.classList.contains("hidden") ||
      options.result.classList.contains("hidden")
    ) {
      return;
    }
    const { scrollTop, height, top } = options.viewport.metrics();
    const articleTop = article.getBoundingClientRect().top - top + scrollTop;
    const percentage = readingProgress(
      articleTop,
      article.offsetHeight,
      scrollTop,
      height,
    );
    progressValue.style.transform = `scaleX(${percentage / 100})`;
    progress.setAttribute("aria-valuenow", String(percentage));
    progress.setAttribute(
      "aria-valuetext",
      translate(options.language, "progress.read", { count: percentage }),
    );
    const sectionIndex = visibleSectionIndex();
    document.querySelectorAll<HTMLElement>("#toc a").forEach((link, index) => {
      if (index === sectionIndex) {
        link.setAttribute("aria-current", "location");
      } else {
        link.removeAttribute("aria-current");
      }
    });
    if (shouldTrack && !restoring) {
      options.trackPosition();
    }
  }

  function scheduleUpdate(trackPosition = false) {
    trackRequested ||= trackPosition;
    if (progressFrame === undefined) {
      progressFrame = requestAnimationFrame(update);
    }
  }

  function cancel() {
    if (progressFrame !== undefined) {
      cancelAnimationFrame(progressFrame);
    }
    if (settlingFrame !== undefined) {
      cancelAnimationFrame(settlingFrame);
    }
    progressFrame = undefined;
    settlingFrame = undefined;
    trackRequested = false;
    restoring = false;
    clearHighlight();
  }

  function resume() {
    const heading =
      continuationSectionIndex === undefined
        ? undefined
        : headings()[continuationSectionIndex];
    if (!heading) {
      hideContinuation();
      return;
    }
    const targetHeading = heading;
    cancel();
    hideContinuation();
    options.beforeResume();
    restoring = true;
    options.viewport.scrollToHeading(
      heading,
      matchMedia("(prefers-reduced-motion: reduce)").matches,
    );
    const startedAt = performance.now();
    let previousTop = options.viewport.metrics().scrollTop;
    let stableFrames = 0;
    function checkPosition(now: number) {
      settlingFrame = undefined;
      const currentTop = options.viewport.metrics().scrollTop;
      stableFrames =
        Math.abs(currentTop - previousTop) < 1 ? stableFrames + 1 : 0;
      previousTop = currentTop;
      const elapsed = now - startedAt;
      if ((elapsed >= 120 && stableFrames >= 4) || elapsed >= 1800) {
        highlight(targetHeading);
        trackRequested = false;
        restoring = false;
        options.afterResume();
        return;
      }
      settlingFrame = requestAnimationFrame(checkPosition);
    }
    settlingFrame = requestAnimationFrame(checkPosition);
  }

  continueButton.addEventListener("click", resume);
  return {
    headings,
    visibleSectionIndex,
    hideContinuation,
    showContinuation,
    highlight,
    scheduleUpdate,
    update,
    cancel,
    reset() {
      cancel();
      options.viewport.reset();
    },
    discardTracking() {
      trackRequested = false;
    },
    get restoring() {
      return restoring;
    },
    get hasContinuation() {
      return continuationSectionIndex !== undefined;
    },
  };
}
