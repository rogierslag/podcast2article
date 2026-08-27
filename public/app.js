import {
  t,
  countText,
  locale,
  localizedFetch,
  errorText,
  LocalizedError,
} from "./localize.js";

const $ = (selector) => document.querySelector(selector);

function html(strings, ...values) {
  let markup = strings[0];
  values.forEach((value, index) => {
    markup += String(value) + strings[index + 1];
  });
  return markup.trim();
}

const browserFetch = window.fetch.bind(window);
window.fetch = async (...arguments_) => {
  const response = await browserFetch(...arguments_);
  if (response.status === 401) {
    location.assign("/login");
    throw new LocalizedError(t("error.sessionExpired"));
  }
  return response;
};
const landing = $("#landing");
const articlesView = $("#articles-view");
const progressView = $("#progress-view");
const resultView = $("#result-view");
const articleReadingProgress = $("#article-reading-progress");
const pageScroll = $(".page-scroll");
const form = $("#job-form");
let currentJob;
let articlesState = [];
let processingState = [];
let overviewRefreshTimer;
let readingProgressFrame;
let readingPositionTrackingRequested = false;
let readingPositionSaveTimer;
let pendingReadingSectionIndex;
let lastSavedReadingSectionIndex;
let readingTrackingOrigin = 0;
let readingTrackingEnabled = false;
let restoringReadingPosition = false;
let continuationSectionIndex;
const materialScrollDistance = 120;

function articleSectionHeadings() {
  return [...document.querySelectorAll("#article section > h2")];
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
  $("#continue-reading").classList.add("hidden");
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

function persistReadingPosition(sectionIndex) {
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

window.addEventListener("pagehide", () => void flushReadingPosition(true));

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
  if (!readingTrackingEnabled || resultView.classList.contains("hidden")) {
    return;
  }
  const sectionIndex = visibleReadingSectionIndex();
  if (sectionIndex !== undefined) {
    persistReadingPosition(sectionIndex);
  }
}

function showContinueReading(readingPosition) {
  clearTimeout(readingPositionSaveTimer);
  pendingReadingSectionIndex = undefined;
  lastSavedReadingSectionIndex = readingPosition?.sectionIndex;
  readingTrackingOrigin = pageScroll.scrollTop;
  readingTrackingEnabled = false;
  const heading = articleSectionHeadings()[readingPosition?.sectionIndex];
  if (!heading) {
    hideContinueReading();
    return;
  }
  continuationSectionIndex = readingPosition.sectionIndex;
  $("#continue-reading-heading").textContent = heading.textContent;
  $("#continue-reading").classList.remove("hidden");
}

function drawAttentionToHeading(heading) {
  heading.classList.remove("resume-highlight");
  void heading.offsetWidth;
  heading.classList.add("resume-highlight");
  heading.setAttribute("tabindex", "-1");
  heading.focus({ preventScroll: true });
  setTimeout(() => {
    heading.classList.remove("resume-highlight");
    heading.removeAttribute("tabindex");
  }, 2200);
}

function afterReadingScroll(callback) {
  const startedAt = performance.now();
  let previousScrollTop = pageScroll.scrollTop;
  let stableFrames = 0;

  function checkPosition(now) {
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

$("#continue-reading").addEventListener("click", () => {
  const heading = articleSectionHeadings()[continuationSectionIndex];
  if (!heading) {
    hideContinueReading();
    return;
  }
  hideContinueReading();
  readingTrackingEnabled = false;
  restoringReadingPosition = true;
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
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
});

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

  articleReadingProgress.querySelector(
    ".reading-progress-value",
  ).style.transform = `scaleX(${progressPercentage / 100})`;
  articleReadingProgress.setAttribute(
    "aria-valuenow",
    String(progressPercentage),
  );
  articleReadingProgress.setAttribute(
    "aria-valuetext",
    t("progress.read", { count: progressPercentage }),
  );
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

localizedFetch("/api/auth")
  .then((response) => response.json())
  .then(({ enabled }) => {
    if (enabled) {
      $("#logout-form").classList.remove("hidden");
    }
  })
  .catch(() => undefined);

const sourceLabels = {
  spotify: "Spotify",
  youtube: "YouTube",
  "google-drive": "Google Drive",
};
const processingStageLabels = {
  queued: t("stage.queued"),
  resolving: t("stage.resolving"),
  downloading: t("stage.downloading"),
  transcribing: t("stage.transcribing"),
  writing: t("stage.writing"),
};

const escapeHtml = (value = "") =>
  String(value).replace(
    /[&<>'"]/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[
        char
      ],
  );
const time = (seconds) => {
  const value = Math.max(0, Math.floor(seconds));
  const h = Math.floor(value / 3600);
  const m = Math.floor((value % 3600) / 60);
  const s = value % 60;
  return h
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
};

function showFormError(message, existingJobId, existingStage) {
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
    location.hash = `job=${existingJobId}`;
    poll(existingJobId);
  });
  formError.append(existingJobLink);
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  $("#form-error").textContent = "";
  const data = Object.fromEntries(new FormData(form));
  try {
    const response = await localizedFetch("/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    const body = await response.json();
    if (!response.ok) {
      if (response.status === 409 && body.existingJobId) {
        showFormError(body.error, body.existingJobId, body.existingStage);
        return;
      }
      throw new LocalizedError(body.error || t("error.jobStart"));
    }
    location.hash = `job=${body.id}`;
    showProgress(body);
    poll(body.id);
  } catch (error) {
    showFormError(errorText(error));
  }
});

function showProgress(job) {
  landing.classList.add("hidden");
  articlesView.classList.add("hidden");
  resultView.classList.add("hidden");
  articleReadingProgress.classList.add("hidden");
  progressView.classList.remove("hidden");
  $("#progress-message").textContent = job.message;
  $("#progress-bar").style.width = `${job.progress}%`;
  $("#progress-percent").textContent = `${job.progress}%`;
  if (job.episode) {
    $("#progress-title").textContent = job.episode.title;
  }
}

async function poll(id) {
  try {
    const response = await localizedFetch(`/api/jobs/${id}`);
    if (!response.ok) {
      throw new LocalizedError(t("error.jobNotFound"));
    }
    const job = await response.json();
    showProgress(job);
    if (job.stage === "complete") {
      return renderResult(job);
    }
    if (job.stage === "failed") {
      throw new LocalizedError(job.error || t("error.processingFailed"));
    }
    setTimeout(() => poll(id), 1800);
  } catch (error) {
    progressView.classList.add("hidden");
    landing.classList.remove("hidden");
    $("#form-error").textContent = errorText(error);
  }
}

function sourceButtons(ids, transcript) {
  return html`
    <span class="sources">
      ${ids
        .map((id) => {
          const item = transcript.find((part) => part.id === id);
          return item
            ? html`
                <button
                  class="source-link"
                  data-source="${id}"
                  aria-label="${escapeHtml(
                    t("source.jump", { time: time(item.start) }),
                  )}"
                  title="${escapeHtml(
                    t("source.jump", { time: time(item.start) }),
                  )}"
                >
                  ${time(item.start)}
                </button>
              `
            : "";
        })
        .join("")}
    </span>
  `;
}

function articleBlock(block, transcript) {
  if (block.kind === "quote") {
    return html`
      <blockquote>
        <p>
          ${escapeHtml(block.text)}${sourceButtons(block.sources, transcript)}
        </p>
      </blockquote>
    `;
  }
  return html`
    <p>${escapeHtml(block.text)} ${sourceButtons(block.sources, transcript)}</p>
  `;
}

function slug(value, index) {
  return `section-${index}-${value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")}`;
}

function renderResult(job) {
  currentJob = job;
  progressView.classList.add("hidden");
  landing.classList.add("hidden");
  articlesView.classList.add("hidden");
  resultView.classList.remove("hidden");
  articleReadingProgress.classList.remove("hidden");
  const episode = job.episode,
    article = job.article,
    transcript = job.transcript;
  const sourceName =
    episode.sourceName || episode.podcast || t("source.original");
  const sourceUrl = episode.sourceUrl || episode.spotifyUrl;
  const sourceLinkLabel =
    episode.sourceType === "google-drive"
      ? t("source.viewDrive")
      : episode.sourceType === "youtube"
        ? t("source.viewYoutube")
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
    ${episode.imageUrl
      ? html`
          <img
            src="${escapeHtml(episode.imageUrl)}"
            alt="${escapeHtml(t("source.image", { name: sourceName }))}"
          />
        `
      : ""}
    <div>
      <span class="kicker">${escapeHtml(sourceName)}</span>
      <h1>${escapeHtml(episode.title)}</h1>
      <p>
        ${escapeHtml(details.join(" · "))}${details.length ? " · " : ""}
        <a
          href="${escapeHtml(sourceUrl)}"
          target="_blank"
          rel="noreferrer"
          style="color: inherit"
        >
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
    <p class="style-note">${escapeHtml(article.styleNote)}</p>
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
        <a href="#${slug(section.heading, index)}">
          ${escapeHtml(section.heading)}
        </a>
      `,
    )
    .join("");
  $("#audio").src = episode.playbackUrl || episode.audioUrl || episode.mediaUrl;
  const requestedTime = Number(
    new URLSearchParams(location.hash.slice(1)).get("time"),
  );
  if (Number.isFinite(requestedTime) && requestedTime >= 0) {
    $("#audio").addEventListener(
      "loadedmetadata",
      () => {
        $("#audio").currentTime = requestedTime;
      },
      { once: true },
    );
  }
  setArticleActionStatus("");
  updateReadButtons();
  renderTranscript(transcript, "");
  document.addEventListener("click", sourceClick);
  resetArticleScroll();
  showContinueReading(job.readingPosition);
  scheduleArticleReadingProgressUpdate();
}

function renderTranscript(transcript, query) {
  const normalized = query.trim().toLowerCase();
  $("#transcript").innerHTML = transcript
    .map((part) => {
      const match =
        !normalized ||
        part.text.toLowerCase().includes(normalized) ||
        part.speaker.toLowerCase().includes(normalized);
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
          <button class="timestamp" data-time="${part.start}">
            ${time(part.start)}
          </button>
          <span class="speaker">${escapeHtml(part.speaker)}</span>
          <p>${textValue}</p>
        </div>
      `;
    })
    .join("");
}

function sourceClick(event) {
  const source = event.target.closest("[data-source]");
  const timestamp = event.target.closest("[data-time]");
  if (source) {
    const segment = document.getElementById(source.dataset.source);
    if (segment) {
      segment.hidden = false;
      segment.scrollIntoView({ behavior: "smooth", block: "center" });
      segment.classList.remove("flash");
      void segment.offsetWidth;
      segment.classList.add("flash");
      const part = currentJob.transcript.find(
        (item) => item.id === source.dataset.source,
      );
      if (part) {
        seek(part.start);
      }
    }
  }
  if (timestamp) {
    seek(Number(timestamp.dataset.time));
  }
}
function seek(seconds) {
  const audio = $("#audio");
  audio.currentTime = seconds;
  audio.play().catch(() => undefined);
}
function setArticleActionStatus(message, isSuccess = false) {
  [$("#article-action-status"), $("#article-read-footer-status")].forEach(
    (status) => {
      status.classList.toggle("is-success", isSuccess);
      status.textContent = message;
    },
  );
}
async function exportToPdf() {
  if (!currentJob) {
    return;
  }
  const job = currentJob;
  const buttons = document.querySelectorAll("[data-pdf-export]");
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
      const body = await response.json().catch(() => ({}));
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

async function copyToClipboard(value) {
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
  const buttons = document.querySelectorAll("[data-share-article]");
  buttons.forEach((button) => {
    button.disabled = true;
  });
  setArticleActionStatus("");
  try {
    const response = await localizedFetch(`/api/jobs/${currentJob.id}/share`, {
      method: "POST",
    });
    const body = await response.json();
    if (!response.ok) {
      throw new LocalizedError(body.error || t("error.shareCreate"));
    }
    if (matchMedia("(max-width: 600px)").matches && navigator.share) {
      try {
        await navigator.share({
          title: currentJob.article.title,
          text: t("share.message", {
            title: currentJob.article.title,
            url: body.url,
          }),
          url: body.url,
        });
        setArticleActionStatus(t("share.completed"), true);
        return;
      } catch (error) {
        if (error?.name === "AbortError") {
          return;
        }
      }
    }
    await copyToClipboard(body.url);
    setArticleActionStatus(t("share.copied"), true);
  } catch (error) {
    setArticleActionStatus(errorText(error));
  } finally {
    buttons.forEach((button) => {
      button.disabled = false;
    });
  }
}
$("#transcript").addEventListener("click", sourceClick);
$("#transcript-search").addEventListener(
  "input",
  (event) =>
    currentJob && renderTranscript(currentJob.transcript, event.target.value),
);
$("#toggle-transcript").addEventListener("click", () => {
  const transcript = $("#transcript");
  transcript.classList.toggle("hidden");
  $("#toggle-transcript").textContent = transcript.classList.contains("hidden")
    ? t("transcript.show")
    : t("transcript.hide");
});
document
  .querySelectorAll("[data-pdf-export]")
  .forEach((button) => button.addEventListener("click", exportToPdf));
document
  .querySelectorAll("[data-share-article]")
  .forEach((button) => button.addEventListener("click", shareArticle));

async function updateArticleRead(id, read) {
  const response = await localizedFetch(`/api/articles/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ read }),
  });
  const body = await response.json();
  if (!response.ok) {
    throw new LocalizedError(body.error || t("error.readState"));
  }
  return body;
}

function updateReadButtons() {
  const isRead = Boolean(currentJob?.readAt);
  document.querySelectorAll("[data-article-read-toggle]").forEach((button) => {
    button.classList.toggle("is-read", isRead);
    button.setAttribute("aria-pressed", String(isRead));
    button.setAttribute(
      "aria-label",
      isRead ? t("article.markUnreadLabel") : t("article.markReadLabel"),
    );
    button.querySelector("span").textContent = isRead
      ? t("article.readStatus")
      : t("article.markRead");
  });
}

async function toggleCurrentArticleRead(event) {
  if (!currentJob) {
    return;
  }
  const returnToArticles = event.currentTarget.hasAttribute(
    "data-return-to-articles",
  );
  const markAsRead = !currentJob.readAt;
  const buttons = document.querySelectorAll("[data-article-read-toggle]");
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
      pageScroll.scrollTo({ top: 0 });
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
  .querySelectorAll("[data-article-read-toggle]")
  .forEach((button) =>
    button.addEventListener("click", toggleCurrentArticleRead),
  );

function articleDate(article) {
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
  const button = $("#delete-article");
  const status = $("#article-delete-status");
  button.disabled = true;
  status.textContent = "";
  try {
    const response = await localizedFetch(`/api/articles/${currentJob.id}`, {
      method: "DELETE",
    });
    if (!response.ok) {
      const body = await response.json();
      throw new LocalizedError(body.error || t("error.articleDelete"));
    }
    $("#audio").pause();
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

$("#delete-article").addEventListener("click", deleteCurrentArticle);

function articleCard(article) {
  const articleId = escapeHtml(article.id);
  const articleUrl = `/#job=${articleId}`;
  const isRead = Boolean(article.readAt);
  const number = String(
    articlesState.findIndex((item) => item.id === article.id) + 1,
  ).padStart(2, "0");
  return html`
    <article class="article-card ${isRead ? "is-read" : ""}">
      <a
        class="article-card-image ${article.imageUrl
          ? ""
          : "article-card-placeholder"}"
        href="${articleUrl}"
        aria-label="${escapeHtml(t("article.read", { title: article.title }))}"
      >
        ${article.imageUrl
          ? html`<img src="${escapeHtml(article.imageUrl)}" alt="" />`
          : html`<span>${number}</span>`}
      </a>
      <div class="article-card-body">
        <p class="article-card-meta">
          <span>
            ${escapeHtml(
              sourceLabels[article.sourceType] || article.sourceType,
            )}
          </span>
          ${escapeHtml(articleDate(article))} · ${article.readingTimeMinutes}
          ${t("duration.abbreviation")}
        </p>
        <a class="article-card-title" href="${articleUrl}">
          <h3>${escapeHtml(article.title)}</h3>
        </a>
        <p class="article-card-dek">${escapeHtml(article.dek)}</p>
        <div class="article-card-footer">
          <span>${escapeHtml(article.sourceName)}</span>
          <div class="article-card-actions">
            <a href="${articleUrl}">
              ${t("article.readAction")} <span aria-hidden="true">→</span>
            </a>
            <button
              type="button"
              data-read-toggle
              data-article-id="${articleId}"
              data-read="${isRead}"
              aria-label="${isRead
                ? t("article.markUnread")
                : t("article.markRead")}"
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

function articleShelf(title, articles, emptyText, collapsible = false) {
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

function compareArticlesForOverview(left, right) {
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

function processingCard(job) {
  const jobId = escapeHtml(job.id);
  const jobUrl = `/#job=${jobId}`;
  return html`
    <a class="processing-card" href="${jobUrl}">
      <div class="processing-card-visual">
        ${job.imageUrl
          ? html`<img src="${escapeHtml(job.imageUrl)}" alt="" />`
          : html`
              <span class="processing-wave" aria-hidden="true">
                <i></i><i></i><i></i><i></i>
              </span>
            `}
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
          aria-label="${escapeHtml(
            t("progress.complete", { count: Math.round(job.progress) }),
          )}"
        >
          <i style="width: ${Math.max(0, Math.min(100, job.progress))}%"></i>
        </div>
      </div>
    </a>
  `;
}

function processingShelf() {
  return html`
    <section class="article-shelf processing-shelf">
      <div class="article-shelf-heading">
        <h2>${t("overview.processing")}</h2>
        <span class="article-shelf-count">${processingState.length}</span>
      </div>
      ${processingState.length
        ? html`
            <div class="processing-grid">
              ${processingState.map(processingCard).join("")}
            </div>
          `
        : html`
            <p class="article-shelf-empty">${t("overview.noProcessing")}</p>
          `}
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
  const button = event.target.closest("[data-read-toggle]");
  if (!button) {
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

async function showArticles(showLoading = true) {
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
    [articlesState, processingState] = await Promise.all([
      articlesResponse.json(),
      processingResponse.json(),
    ]);
    renderArticlesOverview();
    scheduleOverviewRefresh();
  } catch (error) {
    if (showLoading) {
      $("#articles-content").innerHTML = "";
      $("#articles-count").textContent = "";
    }
    $("#articles-error").textContent = errorText(error);
  }
}

const hashParameters = new URLSearchParams(location.hash.slice(1));
const hashJob = hashParameters.get("job");
if (hashJob && /^[0-9a-f-]{36}$/i.test(hashJob)) {
  poll(hashJob);
} else if (location.pathname.replace(/\/$/, "") === "/articles") {
  showArticles();
}
