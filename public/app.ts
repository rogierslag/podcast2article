import * as z from "zod/mini";
import type {
  ArticleSummary,
  ProcessingJobSummary,
  ArticleParagraph,
  ArticleReadingPosition,
  TranscriptSegment,
} from "../src/types.js";
import type { ClientJob, CompletedClientJob } from "../src/shared/api.js";
import {
  responseData,
  jobSchema,
  errorSchema,
  articleSummarySchema,
  processingSummarySchema,
  shareLinkSchema,
  shareStatsSchema,
  articleSeriesSchema,
} from "../src/shared/api.js";
import { requiredElement } from "./dom.js";
import { acknowledgeArticleVisit } from "./article-arrivals.js";
import {
  t,
  countText,
  locale,
  localizedFetch,
  errorText,
  LocalizedError,
} from "./localize.js";
import { createSourcePreview } from "./source-preview.js";
import { articleHash, readArticleLocation } from "./article-location.js";
import {
  sourcePrefill,
  prefillDestination,
} from "../src/shared/source-prefill.js";
import { supportsIOSShortcutInstall } from "./ios-shortcut.js";

const $ = (selector: string) => requiredElement(selector, HTMLElement);

function html(strings: TemplateStringsArray, ...values: unknown[]) {
  let markup = strings[0] ?? "";
  values.forEach((value, index) => {
    markup += String(value) + (strings[index + 1] ?? "");
  });
  return markup.trim();
}
const browserFetch = window.fetch.bind(window);

window.fetch = async (...arguments_) => {
  const response = await browserFetch(...arguments_);
  if (response.status === 401) {
    location.assign(
      prefillDestination(
        document.querySelector<HTMLInputElement>("#source-url")?.value,
        "/login",
      ),
    );
    throw new LocalizedError(t("error.sessionExpired"));
  }
  return response;
};
const landing = $("#landing");
const articlesView = $("#articles-view");
const deploymentAlert = $("#deployment-alert");
const progressView = $("#progress-view");
const resultView = $("#result-view");
const articleReadingProgress = $("#article-reading-progress");
const form = requiredElement("#job-form", HTMLFormElement);

function finishInitialLoad() {
  document.documentElement.removeAttribute("data-loading-view");
}
let currentJob: CompletedClientJob | undefined;
let articlesState: ArticleSummary[] = [];
let processingState: ProcessingJobSummary[] = [];
let overviewRefreshTimer: number | undefined;
let readingProgressFrame: number | undefined;
let readingPositionTrackingRequested = false;
let readingPositionSaveTimer: number | undefined;
let pendingReadingSectionIndex: number | undefined;
let lastSavedReadingSectionIndex: number | undefined;
let readingTrackingOrigin = 0;
let readingTrackingEnabled = false;
let restoringReadingPosition = false;
let continuationSectionIndex: number | undefined;
let naturalReadingScroll = false;
let naturalReadingScrollMoved = false;
let readingScrollEndTimer: number | undefined;
const materialScrollDistance = 120;

function stopNaturalReadingScroll() {
  clearTimeout(readingScrollEndTimer);
  naturalReadingScroll = false;
  naturalReadingScrollMoved = false;
  readingPositionTrackingRequested = false;
}

function finishNaturalReadingScroll() {
  // Save the settled reading location, never sections passed on the way to the navigation at the top (including a status-bar tap during momentum).
  if (naturalReadingScrollMoved && window.scrollY > 0) {
    trackReadingPosition(true);
  }
  stopNaturalReadingScroll();
}

function beginNaturalReadingScroll(event: Event) {
  if (event.defaultPrevented || restoringReadingPosition) {
    return;
  }
  naturalReadingScroll = true;
  clearTimeout(readingScrollEndTimer);
  readingScrollEndTimer = setTimeout(finishNaturalReadingScroll, 200);
}

function handleReadingScrollKey(event: KeyboardEvent) {
  if (
    event.defaultPrevented ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    (event.target instanceof Element &&
      event.target.closest(
        'input, textarea, select, button, a, [contenteditable]:not([contenteditable="false"]), [role="slider"]',
      ))
  ) {
    return;
  }
  if (event.key === "Home" || event.key === "End") {
    stopNaturalReadingScroll();
    return;
  }
  if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", " "].includes(event.key)) {
    beginNaturalReadingScroll(event);
  }
}

function articleSectionHeadings() {
  return [...document.querySelectorAll<HTMLElement>("#article section > h2")];
}

function visibleReadingSectionIndex() {
  const headings = articleSectionHeadings();
  const readingLine = Math.min(window.innerHeight * 0.42, 320);
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
  stopNaturalReadingScroll();
  readingPositionTrackingRequested = false;
  readingTrackingEnabled = false;
  restoringReadingPosition = false;
  readingTrackingOrigin = 0;
  window.scrollTo({ top: 0, behavior: "instant" });
}

function persistReadingPosition(sectionIndex: number) {
  if (!currentJob || sectionIndex === lastSavedReadingSectionIndex) {
    return;
  }
  lastSavedReadingSectionIndex = sectionIndex;
  pendingReadingSectionIndex = sectionIndex;
  clearTimeout(readingPositionSaveTimer);
  readingPositionSaveTimer = setTimeout(flushReadingPosition, 700);
}

async function flushReadingPosition(keepalive = false) {
  clearTimeout(readingPositionSaveTimer);
  const jobId = currentJob?.id;
  const pendingSectionIndex = pendingReadingSectionIndex;
  pendingReadingSectionIndex = undefined;
  if (!jobId || pendingSectionIndex === undefined) {
    return;
  }
  try {
    const response = await localizedFetch(
      `/api/jobs/${jobId}/reading-position`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sectionIndex: pendingSectionIndex }),
        keepalive,
      },
    );
    if (!response.ok) {
      lastSavedReadingSectionIndex = undefined;
    }
  } catch {
    lastSavedReadingSectionIndex = undefined;
  }
}

window.addEventListener("pagehide", () => {
  finishNaturalReadingScroll();
  void flushReadingPosition(true);
});

function trackReadingPosition(savePosition = false) {
  if (restoringReadingPosition) {
    return;
  }
  const scrollDistance = Math.abs(window.scrollY - readingTrackingOrigin);
  if (
    continuationSectionIndex !== undefined &&
    scrollDistance >= materialScrollDistance
  ) {
    hideContinueReading();
  }
  if (scrollDistance >= 40) {
    readingTrackingEnabled = true;
  }
  if (!readingTrackingEnabled || resultView.classList.contains("hidden")) {
    return;
  }
  const sectionIndex = visibleReadingSectionIndex();
  if (savePosition && sectionIndex !== undefined) {
    persistReadingPosition(sectionIndex);
  }
}

function showContinueReading(readingPosition?: ArticleReadingPosition) {
  stopNaturalReadingScroll();
  clearTimeout(readingPositionSaveTimer);
  pendingReadingSectionIndex = undefined;
  lastSavedReadingSectionIndex = readingPosition?.sectionIndex;
  readingTrackingOrigin = window.scrollY;
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
  let previousScrollTop = window.scrollY;
  let stableFrames = 0;
  function checkPosition(now: number) {
    const currentScrollTop = window.scrollY;
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
    stopNaturalReadingScroll();
    readingTrackingEnabled = false;
    restoringReadingPosition = true;
    const reducedMotion = matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    const headingOffset =
      parseFloat(getComputedStyle(heading).scrollMarginTop) || 30;
    const headingTop =
      heading.getBoundingClientRect().top + window.scrollY - headingOffset;
    window.scrollTo({
      top: Math.max(0, headingTop),
      behavior: reducedMotion ? "instant" : "smooth",
    });
    afterReadingScroll(() => {
      drawAttentionToHeading(heading);
      readingPositionTrackingRequested = false;
      readingTrackingOrigin = window.scrollY;
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
    resultView.classList.contains("hidden")
  ) {
    return;
  }
  const articleTop = article.getBoundingClientRect().top + window.scrollY;
  const articleEnd = Math.max(
    articleTop,
    articleTop + article.offsetHeight - window.innerHeight,
  );
  const progressRatio =
    articleEnd === articleTop
      ? Number(window.scrollY >= articleTop)
      : (window.scrollY - articleTop) / (articleEnd - articleTop);
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

function handleArticleScroll() {
  scheduleArticleReadingProgressUpdate(naturalReadingScroll);
  if (naturalReadingScroll) {
    naturalReadingScrollMoved = true;
    clearTimeout(readingScrollEndTimer);
    // Fallback for browsers without scrollend; keep momentum in the gesture.
    readingScrollEndTimer = setTimeout(finishNaturalReadingScroll, 200);
  }
}

window.addEventListener("touchmove", beginNaturalReadingScroll, {
  passive: true,
});

window.addEventListener(
  "wheel",
  (event) => {
    if (!event.ctrlKey && event.deltaY !== 0) {
      beginNaturalReadingScroll(event);
    }
  },
  { passive: true },
);

window.addEventListener("keydown", handleReadingScrollKey);

window.addEventListener("scrollend", finishNaturalReadingScroll);

window.addEventListener("scroll", handleArticleScroll, { passive: true });

window.addEventListener("resize", () => scheduleArticleReadingProgressUpdate());
localizedFetch("/api/auth")
  .then((response) =>
    responseData(response, z.object({ enabled: z.boolean() })),
  )
  .then(({ enabled }) => {
    if (enabled) {
      requiredElement("#logout-form", HTMLFormElement).classList.remove(
        "is-unavailable",
      );
    }
  })
  .catch(() => undefined);
const sourcePreview = createSourcePreview(
  requiredElement("#source-preview", HTMLDialogElement),
  requiredElement("#audio", HTMLAudioElement),
);
let routeVersion = 0;
let jobPollTimer: number | undefined;
let processingJob: ClientJob | undefined;
const pendingArticleRetryIds = new Set();
const sourceLabels = {
  spotify: "Spotify",
  rss: "Podcast",
  youtube: "YouTube",
  fathom: "Fathom",
  "google-drive": "Google Drive",
};
const processingStageLabels = {
  queued: t("stage.queued"),
  resolving: t("stage.resolving"),
  downloading: t("stage.downloading"),
  transcribing: t("stage.transcribing"),
  writing: t("stage.writing"),
};
const escapeHtml = (value: unknown = "") =>
  String(value).replace(
    /[&<>'"]/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[
        char
      ] ?? char,
  );
const time = (seconds: number) => {
  const value = Math.max(0, Math.floor(seconds));
  const h = Math.floor(value / 3600);
  const m = Math.floor((value % 3600) / 60);
  const s = value % 60;
  return h
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
};

function showFormError(
  message: string,
  existingJobId?: string,
  existingStage?: string,
) {
  const formError = $("#form-error");
  formError.textContent = message;
  if (!existingJobId || !/^[0-9a-f-]{36}$/i.test(existingJobId)) {
    return;
  }
  formError.append(" ");
  const existingJobLink = document.createElement("a");
  existingJobLink.href = `/#job=${existingJobId}`;
  existingJobLink.textContent =
    existingStage === "complete"
      ? t("duplicate.openArticle")
      : t("duplicate.viewProgress");
  existingJobLink.addEventListener("click", (event) => {
    event.preventDefault();
    openArticleJob(existingJobId);
  });
  formError.append(existingJobLink);
}
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  $("#form-error").textContent = "";
  const data = Object.fromEntries(new FormData(form));
  if (typeof data.sourceUrl !== "string") {
    showFormError(t("error.input"));
    return;
  }
  const source = new URL(data.sourceUrl);
  if (
    ["open.spotify.com", "spotify.com", "www.spotify.com"].includes(
      source.hostname,
    ) &&
    /^\/show\//.test(source.pathname)
  ) {
    location.assign(
      `/series?${new URLSearchParams({ url: source.toString() })}`,
    );
    return;
  }
  try {
    const response = await localizedFetch("/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    const responseBody: unknown = await response.json();
    const body = errorSchema.parse(responseBody);
    if (!response.ok) {
      if (response.status === 409 && body.existingJobId) {
        showFormError(
          body.error ?? t("error.jobStart"),
          body.existingJobId,
          body.existingStage,
        );
        return;
      }
      throw new LocalizedError(body.error || t("error.jobStart"));
    }
    const job = jobSchema.parse(responseBody);
    showProgress(job);
    openArticleJob(job.id);
  } catch (error) {
    showFormError(errorText(error));
  }
});

function showProgress(job: ClientJob) {
  processingJob = job;
  landing.classList.add("hidden");
  articlesView.classList.add("hidden");
  resultView.classList.add("hidden");
  articleReadingProgress.classList.add("hidden");
  progressView.classList.remove("hidden");
  $("#progress-kicker").textContent = t("processing.kicker");
  $("#progress-title").textContent =
    job.episode?.title || t("processing.title");
  $("#progress-message").textContent = job.message;
  $("#progress-bar").style.width = `${job.progress}%`;
  $("#job-progress").setAttribute("aria-valuenow", String(job.progress));
  $("#job-progress").classList.remove("hidden");
  $("#progress-percent").textContent = `${job.progress}%`;
  $("#progress-percent").classList.remove("hidden");
  $("#progress-error").textContent = "";
  $("#progress-hint").textContent = t("processing.leaveHint");
  requiredElement("#job-status-retry", HTMLButtonElement).classList.add(
    "hidden",
  );
  requiredElement("#job-article-retry", HTMLButtonElement).classList.add(
    "hidden",
  );
  requiredElement("#job-article-retry", HTMLButtonElement).disabled =
    pendingArticleRetryIds.has(job.id);
  requiredElement("#job-edit-source", HTMLButtonElement).classList.add(
    "hidden",
  );
  finishInitialLoad();
}

function showProcessingError(
  message: string,
  { failedJob = false, missingJob = false } = {},
) {
  if (!processingJob) {
    return;
  }
  const canReuseTranscript =
    failedJob &&
    !processingJob.savedShareKey &&
    (processingJob.transcript?.length ?? 0) > 0 &&
    Boolean(processingJob.episode);
  const retryLimitReached = (processingJob.articleRetryAttempts ?? 0) >= 2;
  $("#progress-kicker").textContent = t(
    failedJob ? "processing.failed" : "processing.statusUnavailable",
  );
  if (!processingJob.episode) {
    $("#progress-title").textContent = t(
      failedJob ? "processing.failed" : "processing.statusUnavailable",
    );
  }
  $("#progress-message").textContent = "";
  $("#job-progress").classList.add("hidden");
  $("#progress-percent").classList.add("hidden");
  $("#progress-error").textContent = message;
  $("#progress-hint").textContent = missingJob
    ? ""
    : t(
        failedJob
          ? retryLimitReached
            ? "error.articleRetryLimit"
            : canReuseTranscript
              ? "processing.reuseHint"
              : "processing.restartHint"
          : "processing.statusHint",
      );
  requiredElement("#job-status-retry", HTMLButtonElement).classList.toggle(
    "hidden",
    failedJob || missingJob,
  );
  requiredElement("#job-article-retry", HTMLButtonElement).classList.toggle(
    "hidden",
    !canReuseTranscript || retryLimitReached,
  );
  requiredElement("#job-edit-source", HTMLButtonElement).classList.toggle(
    "hidden",
    !failedJob || !processingJob.sourceUrl,
  );
}
requiredElement("#job-status-retry", HTMLButtonElement).addEventListener(
  "click",
  () => {
    if (processingJob) {
      void poll(processingJob.id);
    }
  },
);
requiredElement("#job-edit-source", HTMLButtonElement).addEventListener(
  "click",
  () => {
    if (!processingJob) {
      return;
    }
    requiredElement("#source-url", HTMLInputElement).value =
      processingJob.sourceUrl ?? "";
    requiredElement("[name=language]", HTMLSelectElement, form).value =
      processingJob.language ?? "nl";
    requiredElement("[name=articleLength]", HTMLSelectElement, form).value =
      processingJob.articleLength ?? "standard";
    history.pushState(null, "", "/");
    showArticleRoute();
    $("#form-error").textContent = "";
    requiredElement("#source-url", HTMLInputElement).focus();
  },
);
requiredElement("#job-article-retry", HTMLButtonElement).addEventListener(
  "click",
  async (event) => {
    const button = event.currentTarget;
    if (!(button instanceof HTMLButtonElement) || !processingJob) {
      return;
    }
    const version = routeVersion;
    const jobId = processingJob.id;
    if (
      pendingArticleRetryIds.has(jobId) ||
      processingJob.stage !== "failed" ||
      processingJob.savedShareKey ||
      !processingJob.transcript?.length ||
      !processingJob.episode ||
      (processingJob.articleRetryAttempts ?? 0) >= 2
    ) {
      return;
    }
    pendingArticleRetryIds.add(jobId);
    button.disabled = true;
    $("#progress-error").textContent = "";
    try {
      const response = await localizedFetch(
        `/api/jobs/${jobId}/retry-article`,
        {
          method: "POST",
        },
      );
      const data: unknown = await response.json();
      if (!response.ok) {
        throw new LocalizedError(
          errorSchema.parse(data).error || t("error.jobStart"),
        );
      }
      const job = jobSchema.parse(data);
      if (version === routeVersion) {
        showProgress(job);
        poll(jobId);
      }
    } catch (error) {
      if (version === routeVersion) {
        // The server may have accepted paid work before the response was lost.
        // Reconcile its status before offering another regeneration.
        showProcessingError(errorText(error));
      }
    } finally {
      pendingArticleRetryIds.delete(jobId);
      button.disabled = pendingArticleRetryIds.has(processingJob?.id ?? "");
    }
  },
);

async function poll(id: string, version = ++routeVersion) {
  clearTimeout(jobPollTimer);
  if (processingJob?.id !== id) {
    // Drop the previous job's recovery controls while preserving the initial loading shell until the requested job's state is known.
    processingJob = { id, progress: 0, message: t("job.checkingSource") };
    $("#progress-title").textContent = t("job.checkingSource");
    $("#progress-kicker").textContent = "";
    $("#progress-message").textContent = "";
    $("#progress-error").textContent = "";
    $("#progress-hint").textContent = "";
    for (const selector of [
      "#job-status-retry",
      "#job-article-retry",
      "#job-edit-source",
      "#job-progress",
      "#progress-percent",
    ]) {
      $(selector).classList.add("hidden");
    }
  }
  let missingJob = false;
  try {
    const response = await localizedFetch(`/api/jobs/${id}`);
    if (!response.ok) {
      missingJob = response.status === 404;
      throw new LocalizedError(
        t(missingJob ? "error.jobNotFound" : "processing.statusUnavailable"),
      );
    }
    const job = await responseData(response, jobSchema);
    if (version !== routeVersion) {
      return;
    }
    showProgress(job);
    if (job.stage === "complete") {
      return renderResult(job);
    }
    if (job.stage === "failed") {
      showProcessingError(job.error || t("error.processingFailed"), {
        failedJob: true,
      });
      return;
    }
    jobPollTimer = setTimeout(() => poll(id, version), 1800);
  } catch (error) {
    if (version !== routeVersion) {
      return;
    }
    showProgress(
      processingJob?.id === id
        ? processingJob
        : {
            id,
            progress: 0,
            message: "",
          },
    );
    showProcessingError(errorText(error), { missingJob });
  }
}

function sourceButtons(ids: string[], transcript: TranscriptSegment[]) {
  const buttons = ids
    .map((id) => {
      const item = transcript.find((part) => part.id === id);
      return item
        ? html`
            <button
              class="source-link"
              data-source="${id}"
              aria-label="${escapeHtml(t("source.jump", { time: time(item.start) }))}"
              title="${escapeHtml(t("source.jump", { time: time(item.start) }))}"
            >
              ${time(item.start)}
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
  transcript: TranscriptSegment[],
) {
  if (block.kind === "quote") {
    return html`
      <blockquote>
        <p>
          ${escapeHtml(block.text)} ${sourceButtons(block.sources, transcript)}
        </p>
      </blockquote>
    `;
  }
  return html`
    <p>${escapeHtml(block.text)} ${sourceButtons(block.sources, transcript)}</p>
  `;
}

function slug(value: string, index: number) {
  return `section-${index}-${value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")}`;
}

function renderResult(job: ClientJob) {
  if (!job.episode || !job.article || !job.transcript) {
    throw new Error("Incomplete article response");
  }
  sourcePreview.close();
  currentJob = {
    ...job,
    episode: job.episode,
    article: job.article,
    transcript: job.transcript,
  };
  void updateArticleSeries(job);
  void updateArticleShareStats(job);
  progressView.classList.add("hidden");
  landing.classList.add("hidden");
  articlesView.classList.add("hidden");
  resultView.classList.remove("hidden");
  articleReadingProgress.classList.remove("hidden");
  const episode = job.episode,
    article = job.article,
    transcript = job.transcript;
  const sourceName = episode.sourceName || t("source.original");
  const sourceUrl = episode.sourceUrl;
  const sourceLinkLabel =
    episode.sourceType === "google-drive"
      ? t("source.viewDrive")
      : episode.sourceType === "youtube"
        ? t("source.viewYoutube")
        : episode.sourceType === "fathom"
          ? t("source.viewFathom")
          : episode.sourceType === "rss"
            ? t("source.viewPodcast")
            : t("source.viewSpotify");
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
  $("#episode-hero").innerHTML = html`
    ${
      episode.imageUrl
        ? html`
            <img
              class="source-attribution-image"
              src="${escapeHtml(episode.imageUrl)}"
              alt="${escapeHtml(t("source.image", { name: sourceName }))}"
            />
          `
        : ""
    }
    <div class="source-attribution-body">
      <span class="source-attribution-publication"
        >${escapeHtml(sourceName)}</span
      >
      <p class="source-attribution-title">${escapeHtml(episode.title)}</p>
      <p class="source-attribution-meta">
        ${escapeHtml(details.join(" · "))}${details.length ? " · " : ""}
        <a href="${escapeHtml(sourceUrl)}" target="_blank" rel="noreferrer">
          ${sourceLinkLabel}
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
            .map((paragraph) => articleBlock(paragraph, transcript))
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
        t("article.byline", {
          reading: countText("reading", article.readingTimeMinutes),
          sources: countText("sources", transcript.length),
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
                ${escapeHtml(item.text)}
                ${sourceButtons(item.sources, transcript)}
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
        <a href="${articleHash(job.id, slug(section.heading, index))}">
          ${escapeHtml(section.heading)}
        </a>
      `,
    )
    .join("");
  requiredElement("#audio", HTMLAudioElement).src =
    episode.playbackUrl || episode.mediaUrl;
  const requestedTime = readArticleLocation(location.hash).time;
  if (
    requestedTime !== undefined &&
    Number.isFinite(requestedTime) &&
    requestedTime >= 0
  ) {
    requiredElement("#audio", HTMLAudioElement).addEventListener(
      "loadedmetadata",
      () => {
        requiredElement("#audio", HTMLAudioElement).currentTime = requestedTime;
      },
      { once: true },
    );
  }
  setArticleActionStatus("");
  updateReadButtons();
  renderTranscript(transcript, "");
  $(".transcript-head").classList.toggle("hidden", Boolean(job.savedShareKey));
  $("#transcript").classList.toggle("hidden", Boolean(job.savedShareKey));
  requiredElement("#toggle-transcript", HTMLButtonElement).setAttribute(
    "aria-expanded",
    String(!job.savedShareKey),
  );
  requiredElement("#toggle-transcript", HTMLButtonElement).textContent = t(
    job.savedShareKey ? "transcript.show" : "transcript.hide",
  );
  resetArticleScroll();
  showContinueReading(job.readingPosition);
  restoreArticleSection();
  scheduleArticleReadingProgressUpdate();
}

function renderTranscript(transcript: TranscriptSegment[], query: string) {
  const normalized = query.trim().toLowerCase();
  let matchCount = 0;
  $("#transcript-segments").innerHTML = transcript
    .map((part) => {
      const match =
        !normalized ||
        part.text.toLowerCase().includes(normalized) ||
        part.speaker.toLowerCase().includes(normalized);
      if (match) {
        matchCount += 1;
      }
      let textValue = escapeHtml(part.text);
      if (normalized && match) {
        const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        textValue = textValue.replace(
          new RegExp(`(${escaped})`, "ig"),
          "<mark>$1</mark>",
        );
      }
      return html`
        <div class="segment" id="${part.id}" ${match ? "" : "hidden"}>
          <button
            class="timestamp"
            data-time="${part.start}"
            aria-label="${escapeHtml(t("transcript.playFrom", { time: time(part.start) }))}"
          >
            ${time(part.start)}
          </button>
          <span class="speaker">${escapeHtml(part.speaker)}</span>
          <p>${textValue}</p>
        </div>
      `;
    })
    .join("");
  const noResults = Boolean(normalized) && matchCount === 0;
  $("#transcript-empty").hidden = !noResults;
  $("#transcript-search-status").textContent = noResults
    ? t("transcript.noResults")
    : "";
}

function sourceClick(event: MouseEvent) {
  if (!(event.target instanceof Element)) {
    return;
  }
  const source = event.target.closest<HTMLElement>("[data-source]");
  if (source) {
    const segment = currentJob?.transcript.find(
      (part) => part.id === source.dataset.source,
    );
    if (segment) {
      stopNaturalReadingScroll();
      sourcePreview.open({ ...segment, label: time(segment.start) }, source);
    }
    return;
  }
  const timestamp = event.target.closest<HTMLElement>("[data-time]");
  if (timestamp) {
    seek(Number(timestamp.dataset.time));
  }
}

function seek(seconds: number) {
  const audio = requiredElement("#audio", HTMLAudioElement);
  audio.currentTime = seconds;
  audio.play().catch(() => undefined);
}
let articleActionStatusTimer: number | undefined;

function setArticleActionStatus(message: string, isSuccess = false) {
  clearTimeout(articleActionStatusTimer);
  [$("#article-action-status"), $("#article-read-footer-status")].forEach(
    (status) => {
      status.classList.toggle("is-success", isSuccess);
      status.textContent = message;
    },
  );
  if (message && isSuccess) {
    articleActionStatusTimer = setTimeout(
      () => setArticleActionStatus(""),
      4000,
    );
  }
}

async function exportToPdf() {
  if (!currentJob) {
    return;
  }
  const job = currentJob;
  const buttons =
    document.querySelectorAll<HTMLButtonElement>("[data-pdf-export]");
  buttons.forEach((button) => {
    button.disabled = true;
    const label = button.querySelector("span");
    if (label) {
      label.textContent = t("pdf.creating");
    }
  });
  setArticleActionStatus("");
  try {
    const response = await localizedFetch(`/api/jobs/${job.id}/pdf`);
    if (!response.ok) {
      const body = await responseData(response, errorSchema).catch(() => ({
        error: undefined,
      }));
      throw new LocalizedError(body.error || t("error.pdfExport"));
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    const title =
      job.article.title
        .replace(/[\\/:*?\"<>|]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 120) || t("article.filename");
    link.href = url;
    link.download = `${title}.pdf`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setArticleActionStatus(t("pdf.downloaded"), true);
  } catch (error) {
    setArticleActionStatus(errorText(error));
  } finally {
    buttons.forEach((button) => {
      button.disabled = false;
      const label = button.querySelector("span");
      if (label) {
        label.textContent = t("article.downloadPdf");
      }
    });
  }
}

async function copyToClipboard(value: string) {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(value);
  }
  const input = document.createElement("textarea");
  input.value = value;
  input.setAttribute("readonly", "");
  input.style.position = "fixed";
  input.style.opacity = "0";
  document.body.append(input);
  input.select();
  const copied = document.execCommand("copy");
  input.remove();
  if (!copied) {
    throw new LocalizedError(t("error.copy"));
  }
}

async function shareArticle() {
  if (!currentJob) {
    return;
  }
  const buttons = document.querySelectorAll<HTMLButtonElement>(
    "[data-share-article]",
  );
  buttons.forEach((button) => {
    button.disabled = true;
  });
  setArticleActionStatus("");
  try {
    const response = await localizedFetch(`/api/jobs/${currentJob.id}/share`, {
      method: "POST",
    });
    const data: unknown = await response.json();
    const body = errorSchema.parse(data);
    if (!response.ok) {
      throw new LocalizedError(body.error || t("error.shareCreate"));
    }
    const link = shareLinkSchema.parse(data);
    if (matchMedia("(max-width: 600px)").matches && navigator.share) {
      try {
        // iOS share targets can discard separate URL or text items.
        // Keep the message and permalink together in a single text item.
        await navigator.share({
          text: `${t("share.message", {
            title: currentJob.article.title,
          })}\n\n${link.url}`,
        });
        setArticleActionStatus(t("share.completed"), true);
        return;
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "name" in error &&
          error.name === "AbortError"
        ) {
          return;
        }
      }
    }
    await copyToClipboard(link.url);
    setArticleActionStatus(t("share.copied"), true);
  } catch (error) {
    setArticleActionStatus(errorText(error));
  } finally {
    buttons.forEach((button) => {
      button.disabled = false;
    });
  }
}

resultView.addEventListener("click", sourceClick);
requiredElement("#transcript-search", HTMLInputElement).addEventListener(
  "input",
  (event) =>
    currentJob &&
    event.target instanceof HTMLInputElement &&
    renderTranscript(currentJob.transcript, event.target.value),
);
requiredElement("#clear-transcript-search", HTMLButtonElement).addEventListener(
  "click",
  () => {
    const search = requiredElement("#transcript-search", HTMLInputElement);
    search.value = "";
    if (currentJob) {
      renderTranscript(currentJob.transcript, "");
    }
    search.focus({ preventScroll: true });
  },
);
requiredElement("#toggle-transcript", HTMLButtonElement).addEventListener(
  "click",
  () => {
    const transcript = $("#transcript");
    transcript.classList.toggle("hidden");
    requiredElement("#toggle-transcript", HTMLButtonElement).setAttribute(
      "aria-expanded",
      String(!transcript.classList.contains("hidden")),
    );
    requiredElement("#toggle-transcript", HTMLButtonElement).textContent =
      transcript.classList.contains("hidden")
        ? t("transcript.show")
        : t("transcript.hide");
  },
);
document
  .querySelectorAll<HTMLButtonElement>("[data-pdf-export]")
  .forEach((button) => button.addEventListener("click", exportToPdf));
document
  .querySelectorAll<HTMLButtonElement>("[data-share-article]")
  .forEach((button) => button.addEventListener("click", shareArticle));

async function updateArticleRead(id: string, read: boolean) {
  const response = await localizedFetch(`/api/articles/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ read }),
  });
  const data: unknown = await response.json();
  const body = errorSchema.parse(data);
  if (!response.ok) {
    throw new LocalizedError(body.error || t("error.readState"));
  }
  return articleSummarySchema.parse(data);
}

function updateReadButtons() {
  const isRead = Boolean(currentJob?.readAt);
  document
    .querySelectorAll<HTMLButtonElement>("[data-article-read-toggle]")
    .forEach((button) => {
      button.classList.toggle("is-read", isRead);
      button.setAttribute("aria-pressed", String(isRead));
      button.setAttribute(
        "aria-label",
        isRead ? t("article.markUnreadLabel") : t("article.markReadLabel"),
      );
      requiredElement("span", HTMLElement, button).textContent = isRead
        ? t("article.readStatus")
        : t("article.markRead");
    });
}

async function toggleCurrentArticleRead(event: Event) {
  if (!currentJob) {
    return;
  }
  if (!(event.currentTarget instanceof HTMLElement)) {
    return;
  }
  const returnToArticles = event.currentTarget.hasAttribute(
    "data-return-to-articles",
  );
  const markAsRead = !currentJob.readAt;
  const buttons = document.querySelectorAll<HTMLButtonElement>(
    "[data-article-read-toggle]",
  );
  buttons.forEach((button) => {
    button.disabled = true;
  });
  setArticleActionStatus("");
  try {
    const article = await updateArticleRead(currentJob.id, markAsRead);
    currentJob.readAt = article.readAt;
    updateReadButtons();
    if (returnToArticles && markAsRead) {
      history.replaceState({}, "", "/articles");
      window.scrollTo({ top: 0 });
      await showArticles();
    }
  } catch (error) {
    setArticleActionStatus(errorText(error));
  } finally {
    buttons.forEach((button) => {
      button.disabled = false;
    });
  }
}
document
  .querySelectorAll<HTMLButtonElement>("[data-article-read-toggle]")
  .forEach((button) =>
    button.addEventListener("click", toggleCurrentArticleRead),
  );

function articleDate(article: ArticleSummary) {
  const value = article.publishedAt || article.completedAt;
  return new Date(value).toLocaleDateString(locale, {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

async function deleteCurrentArticle() {
  if (!currentJob) {
    return;
  }
  if (!window.confirm(t("article.deleteConfirm"))) {
    return;
  }
  const button = requiredElement("#delete-article", HTMLButtonElement);
  const status = $("#article-delete-status");
  button.disabled = true;
  status.textContent = "";
  try {
    const response = await localizedFetch(`/api/articles/${currentJob.id}`, {
      method: "DELETE",
    });
    if (!response.ok) {
      const body = await responseData(response, errorSchema);
      throw new LocalizedError(body.error || t("error.articleDelete"));
    }
    requiredElement("#audio", HTMLAudioElement).pause();
    clearTimeout(readingPositionSaveTimer);
    pendingReadingSectionIndex = undefined;
    hideContinueReading();
    currentJob = undefined;
    location.replace("/articles");
  } catch (error) {
    status.textContent = errorText(error);
    button.disabled = false;
  }
}
requiredElement("#delete-article", HTMLButtonElement).addEventListener(
  "click",
  deleteCurrentArticle,
);

function articleCard(article: ArticleSummary) {
  const articleId = escapeHtml(article.id);
  const articleUrl = `/#job=${articleId}`;
  const isRead = Boolean(article.readAt);
  const number = String(
    articlesState.findIndex((item) => item.id === article.id) + 1,
  ).padStart(2, "0");
  return html`
    <article class="article-card ${isRead ? "is-read" : ""}">
      <a
        class="article-card-image ${article.imageUrl ? "" : "article-card-placeholder"}"
        href="${articleUrl}"
        aria-label="${escapeHtml(
          t("article.read", {
            title: article.imageUrl
              ? article.title
              : `${number}: ${article.title}`,
          }),
        )}"
      >
        ${
          article.imageUrl
            ? html`<img src="${escapeHtml(article.imageUrl)}" alt="" />`
            : html`<span>${number}</span>`
        }
      </a>
      <div class="article-card-body">
        <p class="article-card-meta">
          ${escapeHtml(articleDate(article))} · ${article.readingTimeMinutes}
          ${t("duration.abbreviation")}
        </p>
        <a class="article-card-title" href="${articleUrl}">
          <h3>${escapeHtml(article.title)}</h3>
        </a>
        <p class="article-card-publication">
          ${escapeHtml(article.sourceName)}
        </p>
        <p class="article-card-dek">${escapeHtml(article.dek)}</p>
        <div class="article-card-footer">
          <div class="article-card-actions">
            <a class="article-card-read" href="${articleUrl}">
              ${t("article.readAction")} <span aria-hidden="true">→</span>
            </a>
            <button
              class="article-card-read-toggle"
              type="button"
              data-read-toggle
              data-article-id="${articleId}"
              data-read="${isRead}"
              aria-label="${
                isRead
                  ? t("article.markUnreadLabel")
                  : t("article.markReadLabel")
              }"
              aria-pressed="${isRead}"
            >
              <svg aria-hidden="true" viewBox="0 0 24 24">
                <path d="m5 12 4 4L19 6" />
              </svg>
              ${isRead ? t("article.readStatus") : t("article.markRead")}
            </button>
          </div>
        </div>
      </div>
    </article>
  `;
}

function articleShelf(
  title: string,
  articles: ArticleSummary[],
  emptyText: string,
  collapsible = false,
) {
  const content = articles.length
    ? html`
        <div class="articles-grid">${articles.map(articleCard).join("")}</div>
      `
    : html`<p class="article-shelf-empty">${emptyText}</p>`;
  if (collapsible) {
    return html`
      <details class="article-shelf collapsible-shelf">
        <summary class="article-shelf-heading">
          <h2>
            ${title}
            <span class="article-shelf-count">${articles.length}</span>
            <svg aria-hidden="true" viewBox="0 0 24 24">
              <path d="m6 9 6 6 6-6" />
            </svg>
          </h2>
        </summary>
        ${content}
      </details>
    `;
  }
  return html`
    <section class="article-shelf">
      <div class="article-shelf-heading">
        <h2>${title}</h2>
        <span class="article-shelf-count">${articles.length}</span>
      </div>
      ${content}
    </section>
  `;
}

function compareArticlesForOverview(
  left: ArticleSummary,
  right: ArticleSummary,
) {
  if (left.readAt && right.readAt) {
    return right.readAt.localeCompare(left.readAt);
  }
  if (left.readAt) {
    return 1;
  }
  if (right.readAt) {
    return -1;
  }
  return right.completedAt.localeCompare(left.completedAt);
}

function processingCard(job: ProcessingJobSummary) {
  const jobId = escapeHtml(job.id);
  const jobUrl = `/#job=${jobId}`;
  return html`
    <a class="processing-card" href="${jobUrl}">
      <div class="processing-card-visual">
        ${
          job.imageUrl
            ? html`<img src="${escapeHtml(job.imageUrl)}" alt="" />`
            : html`
                <span class="processing-wave" aria-hidden="true">
                  <i></i><i></i><i></i><i></i>
                </span>
              `
        }
      </div>
      <div class="processing-card-body">
        <p>
          <span>
            ${escapeHtml(processingStageLabels[job.stage] || job.stage)}
          </span>
          ${escapeHtml(job.sourceName)}
        </p>
        <h3>${escapeHtml(job.title)}</h3>
        <div class="processing-status">
          <span>${escapeHtml(job.message)}</span>
          <strong>${Math.round(job.progress)}%</strong>
        </div>
        <div
          class="processing-track"
          aria-label="${escapeHtml(t("progress.complete", { count: Math.round(job.progress) }))}"
        >
          <i style="width: ${Math.max(0, Math.min(100, job.progress))}%"></i>
        </div>
      </div>
    </a>
  `;
}

function processingShelf() {
  if (processingState.length === 0) {
    return "";
  }
  return html`
    <section class="article-shelf processing-shelf">
      <div class="article-shelf-heading">
        <h2>${t("overview.processing")}</h2>
        <span class="article-shelf-count">${processingState.length}</span>
      </div>
      <div class="processing-grid">
        ${processingState.map(processingCard).join("")}
      </div>
    </section>
  `;
}

function renderArticlesOverview() {
  articlesState.sort(compareArticlesForOverview);
  const unread = articlesState.filter((article) => !article.readAt);
  const read = articlesState.filter((article) => article.readAt);
  if (articlesState.length === 0 && processingState.length === 0) {
    $("#articles-count").textContent = t("overview.noArticles");
    $("#articles-content").innerHTML = processingShelf();
    $("#articles-empty").classList.remove("hidden");
    return;
  }
  $("#articles-count").textContent = t("overview.count", {
    processing: processingState.length,
    unread: unread.length,
    read: read.length,
  });
  $("#articles-content").innerHTML =
    processingShelf() +
    articleShelf(t("overview.unread"), unread, t("overview.caughtUp")) +
    articleShelf(t("article.readStatus"), read, t("overview.noRead"), true);
  $("#articles-empty").classList.add("hidden");
}

function scheduleOverviewRefresh() {
  clearTimeout(overviewRefreshTimer);
  if (processingState.length > 0) {
    overviewRefreshTimer = setTimeout(() => showArticles(false), 3000);
  }
}

articlesView.addEventListener("click", async (event) => {
  const button =
    event.target instanceof Element
      ? event.target.closest<HTMLButtonElement>("[data-read-toggle]")
      : null;
  if (!button || !button.dataset.articleId) {
    return;
  }
  button.disabled = true;
  $("#articles-error").textContent = "";
  try {
    const updated = await updateArticleRead(
      button.dataset.articleId,
      button.dataset.read !== "true",
    );
    articlesState = articlesState.map((article) =>
      article.id === updated.id ? updated : article,
    );
    renderArticlesOverview();
  } catch (error) {
    $("#articles-error").textContent = errorText(error);
    button.disabled = false;
  }
});

async function refreshDeploymentAlert() {
  try {
    const response = await localizedFetch("/api/deployment-status");
    const status = response.ok
      ? await responseData(response, z.object({ failed: z.boolean() }))
      : undefined;
    deploymentAlert.classList.toggle("hidden", status?.failed !== true);
  } catch {
    deploymentAlert.classList.add("hidden");
  }
}

async function showArticles(showLoading = true) {
  const version = routeVersion;
  void refreshDeploymentAlert();
  landing.classList.add("hidden");
  progressView.classList.add("hidden");
  resultView.classList.add("hidden");
  articleReadingProgress.classList.add("hidden");
  articlesView.classList.remove("hidden");
  if (showLoading) {
    $("#articles-content").innerHTML = html`
      <p class="articles-loading">${t("overview.loading")}</p>
    `;
    $("#articles-empty").classList.add("hidden");
  }
  $("#articles-error").textContent = "";
  try {
    const [articlesResponse, processingResponse] = await Promise.all([
      localizedFetch("/api/articles"),
      localizedFetch("/api/jobs"),
    ]);
    if (!articlesResponse.ok || !processingResponse.ok) {
      throw new LocalizedError(t("error.overviewLoad"));
    }
    const [articles, processing] = await Promise.all([
      responseData(articlesResponse, z.array(articleSummarySchema)),
      responseData(processingResponse, z.array(processingSummarySchema)),
    ]);
    if (version !== routeVersion) {
      return;
    }
    articlesState = articles;
    processingState = processing;
    renderArticlesOverview();
    if (!document.hidden) {
      void acknowledgeArticleVisit(
        articlesResponse.headers.get("X-Articles-Snapshot") ?? undefined,
      );
    }
    scheduleOverviewRefresh();
  } catch (error) {
    if (version !== routeVersion) {
      return;
    }
    if (showLoading) {
      $("#articles-content").innerHTML = "";
      $("#articles-count").textContent = "";
    }
    $("#articles-error").textContent = errorText(error);
  } finally {
    if (version === routeVersion) {
      finishInitialLoad();
    }
  }
}

function restoreArticleSection() {
  const sectionId = readArticleLocation(location.hash).sectionId;
  const heading = articleSectionHeadings().find(
    (item) => item.id === sectionId,
  );
  if (!heading) {
    return false;
  }
  hideContinueReading();
  stopNaturalReadingScroll();
  heading.scrollIntoView({ behavior: "instant", block: "start" });
  drawAttentionToHeading(heading);
  return true;
}

function openArticleJob(jobId: string) {
  const hash = articleHash(jobId);
  if (location.hash === hash) {
    showArticleRoute();
  } else {
    location.hash = hash;
  }
}

function showArticleRoute() {
  const activePath = location.pathname.replace(/\/$/, "") || "/";
  document.querySelectorAll<HTMLElement>(".main-nav a").forEach((link) => {
    if (link.getAttribute("href") === activePath) {
      link.setAttribute("aria-current", "page");
    } else {
      link.removeAttribute("aria-current");
    }
  });
  sourcePreview.close();
  const { jobId } = readArticleLocation(location.hash);
  if (jobId) {
    if (currentJob?.id === jobId && !resultView.classList.contains("hidden")) {
      if (!restoreArticleSection()) {
        resetArticleScroll();
      }
      return;
    }
    poll(jobId);
    return;
  }
  routeVersion += 1;
  clearTimeout(jobPollTimer);
  if (location.pathname.replace(/\/$/, "") === "/articles") {
    showArticles();
    return;
  }
  resultView.classList.add("hidden");
  progressView.classList.add("hidden");
  articlesView.classList.add("hidden");
  articleReadingProgress.classList.add("hidden");
  landing.classList.remove("hidden");
  finishInitialLoad();
}

window.addEventListener("hashchange", showArticleRoute);
$(".shortcut-install").hidden = !supportsIOSShortcutInstall(navigator);
const incomingSourceUrl = sourcePrefill(
  new URLSearchParams(location.search).get("sourceUrl"),
);
if (incomingSourceUrl && location.pathname === "/") {
  requiredElement("#source-url", HTMLInputElement).value = incomingSourceUrl;
  $("#source-prefill-note").classList.remove("hidden");
}
showArticleRoute();
let articleSeriesRequest = 0;

async function updateArticleSeries(job: ClientJob) {
  const requestId = ++articleSeriesRequest;
  const containers = document.querySelectorAll<HTMLElement>(
    "[data-article-series]",
  );
  const focusedContainer = [...containers].find((container) =>
    container.contains(document.activeElement),
  );
  containers.forEach((container) => {
    container.replaceChildren();
    container.classList.add("hidden");
  });
  if (!["spotify", "rss"].includes(job.episode?.sourceType ?? "")) {
    return;
  }
  containers.forEach((container) => {
    container.classList.remove("hidden");
    container.textContent = t("article.seriesLoading");
  });
  try {
    const response = await localizedFetch(
      `/api/subscriptions/article/${job.id}`,
    );
    const data: unknown = await response.json();
    const errorBody = errorSchema.parse(data);
    if (!response.ok) {
      throw new LocalizedError(errorBody.error || t("error.generic"));
    }
    const result = articleSeriesSchema.parse(data);
    if (currentJob?.id !== job.id || requestId !== articleSeriesRequest) {
      return;
    }
    containers.forEach((container) => {
      const label = document.createElement("span");
      const link = document.createElement("a");
      if (result.subscription) {
        label.textContent = t(
          result.subscription.paused
            ? "article.seriesPaused"
            : "article.seriesFollowing",
        );
        link.textContent = t("article.seriesManage");
        link.href = `/series#subscription-${encodeURIComponent(result.subscription.id)}`;
      } else {
        label.textContent = t("article.seriesInterested");
        link.textContent = t("article.seriesFollow");
        link.href = `/series?${new URLSearchParams({ url: result.feedUrl, preview: "1" })}`;
      }
      container.replaceChildren(label, link);
      if (container === focusedContainer) {
        link.focus();
      }
    });
  } catch {
    if (currentJob?.id !== job.id || requestId !== articleSeriesRequest) {
      return;
    }
    containers.forEach((container) => {
      const label = document.createElement("span");
      label.textContent = t("article.seriesError");
      const retry = document.createElement("button");
      retry.type = "button";
      retry.textContent = t("article.seriesRetry");
      retry.addEventListener("click", () => void updateArticleSeries(job));
      container.replaceChildren(label, retry);
      if (container === focusedContainer) {
        retry.focus();
      }
    });
  }
}

window.addEventListener("pageshow", (event) => {
  if (event.persisted && currentJob) {
    void updateArticleSeries(currentJob);
    void updateArticleShareStats(currentJob);
  }
});

document.addEventListener("visibilitychange", () => {
  if (
    !document.hidden &&
    currentJob &&
    !resultView.classList.contains("hidden")
  ) {
    void updateArticleSeries(currentJob);
    void updateArticleShareStats(currentJob);
  }
});
const shareStatsValues = $("#share-stats-values");
const shareStatsStatus = $("#share-stats-status");
const shareStatsRetry = requiredElement(
  "#share-stats-retry",
  HTMLButtonElement,
);
let shareStatsRequest = 0;

async function updateArticleShareStats(job: ClientJob) {
  const requestId = ++shareStatsRequest;
  shareStatsValues.classList.add("hidden");
  shareStatsRetry.classList.add("hidden");
  shareStatsStatus.textContent = t("share.statsLoading");
  try {
    const response = await localizedFetch(
      `/api/jobs/${encodeURIComponent(job.id)}/share-stats`,
    );
    if (!response.ok) {
      throw new Error("Statistics unavailable");
    }
    const statistics = await responseData(response, shareStatsSchema);
    if (
      !Number.isSafeInteger(statistics.loads) ||
      statistics.loads < 0 ||
      !Number.isSafeInteger(statistics.reads) ||
      statistics.reads < 0
    ) {
      throw new Error("Invalid statistics");
    }
    if (currentJob?.id !== job.id || requestId !== shareStatsRequest) {
      return;
    }
    $("#share-stats-loads").textContent =
      statistics.loads.toLocaleString(locale);
    $("#share-stats-reads").textContent =
      statistics.reads.toLocaleString(locale);
    shareStatsValues.classList.remove("hidden");
    shareStatsStatus.textContent = "";
  } catch {
    if (currentJob?.id !== job.id || requestId !== shareStatsRequest) {
      return;
    }
    shareStatsStatus.textContent = t("share.statsError");
    shareStatsRetry.classList.remove("hidden");
  }
}
shareStatsRetry.addEventListener("click", () => {
  if (currentJob) {
    void updateArticleShareStats(currentJob);
  }
});
