import type { ArticleParagraph, TranscriptSegment } from "../src/types.js";
import type { SharedArticle } from "../src/shared/api.js";
import {
  responseData,
  sharedArticleSchema,
  savedArticleSchema,
  readingPositionSchema,
} from "../src/shared/api.js";
import { requiredElement } from "./dom.js";
import { t, countText, locale, localizedFetch } from "./localize.js";

import { createShareTracker } from "./share-analytics.js";

import { createSourcePreview } from "./source-preview.js";

const $ = (selector: string) => requiredElement(selector, HTMLElement);

function html(strings: TemplateStringsArray, ...values: unknown[]) {
  let markup = strings[0] ?? "";
  values.forEach((value, index) => {
    markup += String(value) + (strings[index + 1] ?? "");
  });
  return markup.trim();
}

const escapeHtml = (value: unknown = "") =>
  String(value).replace(
    /[&<>'"]/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[
        character
      ] ?? character,
  );
const time = (seconds: number) => {
  const value = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const remainder = value % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
    : `${minutes}:${String(remainder).padStart(2, "0")}`;
};
const slug = (value: string, index: number) =>
  `section-${index}-${value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")}`;
const articleReadingProgress = $("#article-reading-progress");
const pageScroll = $(".page-scroll");
let readingProgressFrame: number | undefined;
let readingPositionTrackingRequested = false;
let lastSavedReadingSectionIndex: number | undefined;
let readingTrackingOrigin = 0;
let readingTrackingEnabled = false;
let restoringReadingPosition = false;
let continuationSectionIndex: number | undefined;
let sharedReadingStorageKey: string | undefined;
const materialScrollDistance = 120;

function articleSectionHeadings() {
  return [...document.querySelectorAll<HTMLElement>("#article section > h2")];
}

function visibleReadingSectionIndex() {
  const headings = articleSectionHeadings();
  const scrollViewportTop = pageScroll.getBoundingClientRect().top;
  const readingLine =
    scrollViewportTop + Math.min(pageScroll.clientHeight * 0.42, 320);
  let sectionIndex;
  headings.forEach((heading, index) => {
    if (heading.getBoundingClientRect().top <= readingLine) {
      sectionIndex = index;
    }
  });
  return sectionIndex;
}

function hideContinueReading() {
  requiredElement("#continue-reading", HTMLButtonElement).classList.add(
    "hidden",
  );
  continuationSectionIndex = undefined;
}

function resetArticleScroll() {
  readingPositionTrackingRequested = false;
  readingTrackingEnabled = false;
  restoringReadingPosition = false;
  readingTrackingOrigin = 0;
  const previousScrollBehavior = pageScroll.style.scrollBehavior;
  pageScroll.style.scrollBehavior = "auto";
  pageScroll.scrollTop = 0;
  pageScroll.style.scrollBehavior = previousScrollBehavior;
}

function storedReadingPosition() {
  if (!sharedReadingStorageKey) {
    return undefined;
  }
  try {
    const value = readingPositionSchema.parse(
      JSON.parse(localStorage.getItem(sharedReadingStorageKey) ?? "null"),
    );
    return Number.isInteger(value?.sectionIndex) && value.sectionIndex >= 0
      ? value
      : undefined;
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
  if (restoringReadingPosition) {
    return;
  }
  const scrollDistance = Math.abs(pageScroll.scrollTop - readingTrackingOrigin);
  if (
    continuationSectionIndex !== undefined &&
    scrollDistance >= materialScrollDistance
  ) {
    hideContinueReading();
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
  const sectionIndex = visibleReadingSectionIndex();
  if (sectionIndex !== undefined) {
    persistReadingPosition(sectionIndex);
  }
}

function showContinueReading(readingPosition?: { sectionIndex: number }) {
  lastSavedReadingSectionIndex = readingPosition?.sectionIndex;
  readingTrackingOrigin = pageScroll.scrollTop;
  readingTrackingEnabled = false;
  const heading = readingPosition
    ? articleSectionHeadings()[readingPosition.sectionIndex]
    : undefined;
  if (!heading || !readingPosition) {
    hideContinueReading();
    return;
  }
  continuationSectionIndex = readingPosition.sectionIndex;
  $("#continue-reading-heading").textContent = heading.textContent;
  requiredElement("#continue-reading", HTMLButtonElement).classList.remove(
    "hidden",
  );
}

function drawAttentionToHeading(heading: HTMLElement) {
  heading.classList.remove("resume-highlight");
  void heading.offsetWidth;
  heading.classList.add("resume-highlight");
  heading.setAttribute("tabindex", "-1");
  heading.focus({ preventScroll: true });
  setTimeout(() => {
    heading.classList.remove("resume-highlight");
  }, 2200);
}

function afterReadingScroll(callback: () => void) {
  const startedAt = performance.now();
  let previousScrollTop = pageScroll.scrollTop;
  let stableFrames = 0;

  function checkPosition(now: number) {
    const currentScrollTop = pageScroll.scrollTop;
    stableFrames =
      Math.abs(currentScrollTop - previousScrollTop) < 1 ? stableFrames + 1 : 0;
    previousScrollTop = currentScrollTop;
    const elapsed = now - startedAt;
    if ((elapsed >= 120 && stableFrames >= 4) || elapsed >= 1800) {
      callback();
      return;
    }
    requestAnimationFrame(checkPosition);
  }

  requestAnimationFrame(checkPosition);
}

requiredElement("#continue-reading", HTMLButtonElement).addEventListener(
  "click",
  () => {
    const heading =
      continuationSectionIndex === undefined
        ? undefined
        : articleSectionHeadings()[continuationSectionIndex];
    if (!heading) {
      hideContinueReading();
      return;
    }
    hideContinueReading();
    readingTrackingEnabled = false;
    restoringReadingPosition = true;
    const reducedMotion = matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    const headingTop =
      heading.getBoundingClientRect().top -
      pageScroll.getBoundingClientRect().top +
      pageScroll.scrollTop -
      30;
    pageScroll.scrollTo({
      top: Math.max(0, headingTop),
      behavior: reducedMotion ? "auto" : "smooth",
    });
    afterReadingScroll(() => {
      drawAttentionToHeading(heading);
      readingPositionTrackingRequested = false;
      readingTrackingOrigin = pageScroll.scrollTop;
      readingTrackingEnabled = false;
      restoringReadingPosition = false;
    });
  },
);

function updateArticleReadingProgress() {
  readingProgressFrame = undefined;
  const shouldTrackReadingPosition = readingPositionTrackingRequested;
  readingPositionTrackingRequested = false;
  const article = $("#article");
  if (
    !article ||
    articleReadingProgress.classList.contains("hidden") ||
    $("#shared-result").classList.contains("hidden")
  ) {
    return;
  }

  const pageScrollRect = pageScroll.getBoundingClientRect();
  const articleTop =
    article.getBoundingClientRect().top -
    pageScrollRect.top +
    pageScroll.scrollTop;
  const articleEnd = Math.max(
    articleTop,
    articleTop + article.offsetHeight - pageScroll.clientHeight,
  );
  const progressRatio =
    articleEnd === articleTop
      ? Number(pageScroll.scrollTop >= articleTop)
      : (pageScroll.scrollTop - articleTop) / (articleEnd - articleTop);
  const progressPercentage = Math.round(
    Math.min(1, Math.max(0, progressRatio)) * 100,
  );

  requiredElement(
    ".reading-progress-value",
    HTMLElement,
    articleReadingProgress,
  ).style.transform = `scaleX(${progressPercentage / 100})`;
  articleReadingProgress.setAttribute(
    "aria-valuenow",
    String(progressPercentage),
  );
  articleReadingProgress.setAttribute(
    "aria-valuetext",
    t("progress.read", { count: progressPercentage }),
  );
  const sectionIndex = visibleReadingSectionIndex();
  document.querySelectorAll<HTMLElement>("#toc a").forEach((link, index) => {
    if (index === sectionIndex) {
      link.setAttribute("aria-current", "location");
    } else {
      link.removeAttribute("aria-current");
    }
  });
  if (shouldTrackReadingPosition) {
    trackReadingPosition();
  }
}

function scheduleArticleReadingProgressUpdate(trackPosition = false) {
  if (trackPosition) {
    readingPositionTrackingRequested = true;
  }
  if (readingProgressFrame === undefined) {
    readingProgressFrame = requestAnimationFrame(updateArticleReadingProgress);
  }
}

pageScroll.addEventListener(
  "scroll",
  () => scheduleArticleReadingProgressUpdate(true),
  {
    passive: true,
  },
);
window.addEventListener("resize", () => scheduleArticleReadingProgressUpdate());

function sourceButtons(
  ids: string[],
  sources: Pick<TranscriptSegment, "id" | "start">[],
) {
  const buttons = ids
    .map((id) => {
      const source = sources.find((item) => item.id === id);
      return source
        ? html`
            <button
              class="source-link"
              data-time="${source.start}"
              aria-label="${escapeHtml(
                t("source.listen", { time: time(source.start) }),
              )}"
              title="${escapeHtml(
                t("source.listen", { time: time(source.start) }),
              )}"
            >
              ${time(source.start)}
            </button>
          `
        : "";
    })
    .filter(Boolean)
    .join(" ");
  return buttons ? html`<span class="sources">${buttons}</span>` : "";
}

function articleBlock(
  block: ArticleParagraph,
  sources: Pick<TranscriptSegment, "id" | "start">[],
) {
  if (block.kind === "quote") {
    return html`
      <blockquote>
        <p>
          ${escapeHtml(block.text)} ${sourceButtons(block.sources, sources)}
        </p>
      </blockquote>
    `;
  }
  return html`
    <p>${escapeHtml(block.text)} ${sourceButtons(block.sources, sources)}</p>
  `;
}

function renderSharedArticle(shared: SharedArticle, token: string) {
  const { episode, article, sources } = shared;
  const details = [
    episode.publishedAt
      ? new Date(episode.publishedAt).toLocaleDateString(locale, {
          dateStyle: "long",
        })
      : "",
    episode.durationSeconds
      ? countText("duration", Math.round(episode.durationSeconds / 60))
      : "",
  ].filter(Boolean);
  const sourceLabel =
    episode.sourceType === "google-drive"
      ? t("source.viewDrive")
      : episode.sourceType === "youtube"
        ? t("source.viewYoutube")
        : episode.sourceType === "fathom"
          ? t("source.viewFathom")
          : episode.sourceType === "rss"
            ? t("source.viewPodcast")
            : t("source.viewSpotify");
  $("#episode-hero").innerHTML = html`
    ${
      episode.imageUrl
        ? html`
            <img
              class="source-attribution-image"
              src="${escapeHtml(episode.imageUrl)}"
              alt="${escapeHtml(t("source.image", { name: episode.sourceName }))}"
            />
          `
        : ""
    }
    <div class="source-attribution-body">
      <span class="source-attribution-publication"
        >${escapeHtml(episode.sourceName)}</span
      >
      <p class="source-attribution-title">${escapeHtml(episode.title)}</p>
      <p class="source-attribution-meta">
        ${escapeHtml(details.join(" · "))}${details.length ? " · " : ""}
        <a
          href="${escapeHtml(episode.sourceUrl)}"
          target="_blank"
          rel="noreferrer"
        >
          ${sourceLabel}
        </a>
      </p>
    </div>
  `;
  const sections = article.sections
    .map((section, index) => {
      const id = slug(section.heading, index);
      return html`
        <section>
          <h2 id="${id}">${escapeHtml(section.heading)}</h2>
          ${section.paragraphs
            .map((paragraph) => articleBlock(paragraph, sources))
            .join("")}
        </section>
      `;
    })
    .join("");
  $("#article").innerHTML = html`
    <h1>${escapeHtml(article.title)}</h1>
    <p class="dek">${escapeHtml(article.dek)}</p>
    <p class="byline">
      ${escapeHtml(
        t("shared.byline", {
          reading: countText("reading", article.readingTimeMinutes),
        }),
      )}
    </p>
    ${sections}
    <div class="takeaways">
      <h2>${t("article.takeaways")}</h2>
      <ul>
        ${article.takeaways
          .map(
            (item) => html`
              <li>
                ${escapeHtml(item.text)} ${sourceButtons(item.sources, sources)}
              </li>
            `,
          )
          .join("")}
      </ul>
    </div>
  `;
  $("#toc").innerHTML = article.sections
    .map(
      (section, index) => html`
        <a href="#${slug(section.heading, index)}">
          ${escapeHtml(section.heading)}
        </a>
      `,
    )
    .join("");
  requiredElement("#audio", HTMLAudioElement).src =
    `/api/shared/${encodeURIComponent(token)}/audio`;
  $("#shared-loading").classList.add("hidden");
  $("#shared-result").classList.remove("hidden");
  articleReadingProgress.classList.remove("hidden");
  sharedReadingStorageKey = `podcast2article:reading-position:${token}`;
  resetArticleScroll();
  showContinueReading(storedReadingPosition());
  const heading = articleSectionHeadings().find(
    (item) => `#${item.id}` === location.hash,
  );
  if (heading) {
    hideContinueReading();
    heading.scrollIntoView({ behavior: "instant", block: "start" });
    drawAttentionToHeading(heading);
  }
  scheduleArticleReadingProgressUpdate();
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
