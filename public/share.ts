import { formatTimestamp as time } from "./article-format.js";
import {
  renderArticle,
  renderContents,
  renderSourceAttribution,
} from "./article-render.js";
import type { SharedArticle } from "../src/shared/api.js";
import {
  responseData,
  sharedArticleSchema,
  savedArticleSchema,
  readingPositionSchema,
} from "../src/shared/api.js";
import { createReadingView, elementReadingViewport } from "./reading-view.js";
import { requiredElement } from "./dom.js";
import { t, countText, language, localizedFetch } from "./localize.js";

import { createShareTracker } from "./share-analytics.js";

import { createSourcePreview } from "./source-preview.js";

const $ = (selector: string) => requiredElement(selector, HTMLElement);
const articleReadingProgress = $("#article-reading-progress");
const pageScroll = $(".page-scroll");
let lastSavedReadingSectionIndex: number | undefined;
let readingTrackingOrigin = 0;
let readingTrackingEnabled = false;
let sharedReadingStorageKey: string | undefined;
const materialScrollDistance = 120;
const readingView = createReadingView({
  viewport: elementReadingViewport(pageScroll),
  result: $("#shared-result"),
  language,
  trackPosition: trackReadingPosition,
  beforeResume() {
    readingTrackingEnabled = false;
  },
  afterResume() {
    readingTrackingOrigin = pageScroll.scrollTop;
    readingTrackingEnabled = false;
  },
});

function resetArticleScroll() {
  readingTrackingEnabled = false;
  readingTrackingOrigin = 0;
  readingView.reset();
}

function storedReadingPosition() {
  if (!sharedReadingStorageKey) {
    return undefined;
  }
  try {
    return readingPositionSchema.parse(
      JSON.parse(localStorage.getItem(sharedReadingStorageKey) ?? "null"),
    );
  } catch {
    return undefined;
  }
}

function persistReadingPosition(sectionIndex: number) {
  if (
    !sharedReadingStorageKey ||
    sectionIndex === lastSavedReadingSectionIndex
  ) {
    return;
  }
  lastSavedReadingSectionIndex = sectionIndex;
  try {
    localStorage.setItem(
      sharedReadingStorageKey,
      JSON.stringify({ sectionIndex, updatedAt: new Date().toISOString() }),
    );
  } catch {
    // Reading remains available when device storage is disabled or full.
  }
}

function trackReadingPosition() {
  if (readingView.restoring) {
    return;
  }
  const scrollDistance = Math.abs(pageScroll.scrollTop - readingTrackingOrigin);
  if (readingView.hasContinuation && scrollDistance >= materialScrollDistance) {
    readingView.hideContinuation();
  }
  if (scrollDistance >= 40) {
    readingTrackingEnabled = true;
  }
  if (
    !readingTrackingEnabled ||
    $("#shared-result").classList.contains("hidden")
  ) {
    return;
  }
  const sectionIndex = readingView.visibleSectionIndex();
  if (sectionIndex !== undefined) {
    persistReadingPosition(sectionIndex);
  }
}

function showContinueReading(readingPosition?: { sectionIndex: number }) {
  lastSavedReadingSectionIndex = readingPosition?.sectionIndex;
  readingTrackingOrigin = pageScroll.scrollTop;
  readingTrackingEnabled = false;
  readingView.showContinuation(readingPosition);
}

pageScroll.addEventListener("scroll", () => readingView.scheduleUpdate(true), {
  passive: true,
});
window.addEventListener("resize", () => readingView.scheduleUpdate());

function renderSharedArticle(shared: SharedArticle, token: string) {
  const { episode, article, sources } = shared;
  $("#episode-hero").innerHTML = renderSourceAttribution(episode, language);
  $("#article").innerHTML = renderArticle(article, sources, {
    language,
    citationMode: "time",
    byline: t("shared.byline", {
      reading: countText("reading", article.readingTimeMinutes),
    }),
  });
  $("#toc").innerHTML = renderContents(article, (sectionId) => `#${sectionId}`);
  requiredElement("#audio", HTMLAudioElement).src =
    `/api/shared/${encodeURIComponent(token)}/audio`;
  $("#shared-loading").classList.add("hidden");
  $("#shared-result").classList.remove("hidden");
  articleReadingProgress.classList.remove("hidden");
  sharedReadingStorageKey = `podcast2article:reading-position:${token}`;
  resetArticleScroll();
  showContinueReading(storedReadingPosition());
  const heading = readingView
    .headings()
    .find((item) => `#${item.id}` === location.hash);
  if (heading) {
    readingView.hideContinuation();
    heading.scrollIntoView({ behavior: "instant", block: "start" });
    readingView.highlight(heading);
  }
  readingView.scheduleUpdate();
}

$("#shared-main").addEventListener("click", (event) => {
  const button =
    event.target instanceof Element
      ? event.target.closest<HTMLElement>("[data-time]")
      : null;
  if (!button) {
    return;
  }
  const start = Number(button.dataset.time);
  sourcePreview.open({ start, label: time(start) }, button);
});

const sourcePreview = createSourcePreview(
  requiredElement("#source-preview", HTMLDialogElement),
  requiredElement("#audio", HTMLAudioElement),
);

const token = location.pathname.split("/").filter(Boolean).at(-1) ?? "";
localizedFetch(`/api/shared/${encodeURIComponent(token)}`)
  .then(async (response) => {
    if (!response.ok) {
      throw new Error("not found");
    }
    renderSharedArticle(
      await responseData(response, sharedArticleSchema),
      token,
    );
    startShareMonitoring();
    void loadSaveState();
  })
  .catch(() => {
    $("#shared-loading").classList.add("hidden");
    $("#shared-error").classList.remove("hidden");
  });

const saveButtons = [
  ...document.querySelectorAll<HTMLButtonElement>("[data-save-shared]"),
];
const saveStatuses = [
  ...document.querySelectorAll<HTMLElement>("[data-save-status]"),
];

function showSavedArticle(articleId: string) {
  saveButtons.forEach((button) => {
    button.disabled = true;
    button.classList.add("hidden");
  });
  saveStatuses.forEach((status) => {
    status.textContent = t("shared.saved");
  });
  document
    .querySelectorAll<HTMLAnchorElement>("[data-open-saved]")
    .forEach((link) => {
      link.href = `/#job=${encodeURIComponent(articleId)}`;
      link.classList.remove("hidden");
    });
}

async function loadSaveState() {
  try {
    const response = await localizedFetch(
      `/api/saved-shares/${encodeURIComponent(token)}`,
    );
    if (!response.ok) {
      return;
    }
    const { articleId } = await responseData(response, savedArticleSchema);
    document
      .querySelectorAll<HTMLElement>(".shared-save-actions")
      .forEach((actions) => actions.classList.remove("hidden"));
    if (articleId) {
      showSavedArticle(articleId);
    }
  } catch {
    // Account lookup must not interrupt anonymous reading.
  }
}

async function saveArticleToOverview(event: Event) {
  const button = event.currentTarget;
  if (!(button instanceof HTMLButtonElement)) {
    return;
  }
  const focusSavedLink = document.activeElement === button;
  const savedLink = button
    .closest(".shared-save-actions")
    ?.querySelector<HTMLAnchorElement>("[data-open-saved]");
  saveButtons.forEach((button) => {
    button.disabled = true;
    button.textContent = t("shared.saving");
  });
  saveStatuses.forEach((status) => {
    status.textContent = "";
  });
  try {
    const response = await localizedFetch(
      `/api/saved-shares/${encodeURIComponent(token)}`,
      { method: "POST" },
    );
    if (!response.ok) {
      throw new Error(
        response.status === 401 ? "error.sessionExpired" : "error.sharedSave",
      );
    }
    const { articleId } = await responseData(response, savedArticleSchema);
    if (!articleId) {
      throw new Error("error.sharedSave");
    }
    showSavedArticle(articleId);
    if (focusSavedLink) {
      savedLink?.focus();
    }
  } catch (error) {
    saveButtons.forEach((button) => {
      button.disabled = false;
      button.textContent = t("shared.save");
    });
    saveStatuses.forEach((status) => {
      status.textContent = t(
        error instanceof Error && error.message === "error.sessionExpired"
          ? "error.sessionExpired"
          : "error.sharedSave",
      );
    });
  }
}

saveButtons.forEach((button) =>
  button.addEventListener("click", saveArticleToOverview),
);

function startShareMonitoring() {
  // Skip explicitly declared automation without fingerprinting ordinary readers.
  if (navigator.webdriver === true || !globalThis.crypto?.randomUUID) {
    return;
  }
  const visitId = crypto.randomUUID();
  const tracker = createShareTracker({
    send: async (event) => {
      const response = await fetch(
        `/api/shared/${encodeURIComponent(token)}/events`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "omit",
          body: JSON.stringify({ visitId, event }),
        },
      );
      return response.ok;
    },
  });
  for (const event of ["pointerdown", "keydown", "scroll"]) {
    pageScroll.addEventListener(event, () => tracker.activity(), {
      passive: true,
    });
  }
  const tick = () =>
    tracker.tick({
      visible: document.visibilityState === "visible",
      progress: Number(articleReadingProgress.getAttribute("aria-valuenow")),
    });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      tracker.activity();
    }
    void tick();
  });
  setInterval(() => void tick(), 1000);
  void tick();
}
