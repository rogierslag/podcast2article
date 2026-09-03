import { t, countText, locale, localizedFetch } from "./localize.js";

const $ = (selector) => document.querySelector(selector);

function html(strings, ...values) {
  let markup = strings[0];
  values.forEach((value, index) => {
    markup += String(value) + strings[index + 1];
  });
  return markup.trim();
}

const escapeHtml = (value = "") =>
  String(value).replace(
    /[&<>'"]/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[
        character
      ],
  );
const time = (seconds) => {
  const value = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const remainder = value % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
    : `${minutes}:${String(remainder).padStart(2, "0")}`;
};
const slug = (value, index) =>
  `section-${index}-${value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")}`;
const articleReadingProgress = $("#article-reading-progress");
const pageScroll = $(".page-scroll");
let readingProgressFrame;
let readingPositionTrackingRequested = false;
let lastSavedReadingSectionIndex;
let readingTrackingOrigin = 0;
let readingTrackingEnabled = false;
let restoringReadingPosition = false;
let continuationSectionIndex;
let sharedReadingStorageKey;
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

function storedReadingPosition() {
  if (!sharedReadingStorageKey) {
    return undefined;
  }
  try {
    const value = JSON.parse(localStorage.getItem(sharedReadingStorageKey));
    return Number.isInteger(value?.sectionIndex) && value.sectionIndex >= 0
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

function persistReadingPosition(sectionIndex) {
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

function showContinueReading(readingPosition) {
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

function sourceButtons(ids, sources) {
  return html`
    <span class="sources">
      ${ids
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
        .join("")}
    </span>
  `;
}

function articleBlock(block, sources) {
  if (block.kind === "quote") {
    return html`
      <blockquote>
        <p>${escapeHtml(block.text)}${sourceButtons(block.sources, sources)}</p>
      </blockquote>
    `;
  }
  return html`
    <p>${escapeHtml(block.text)} ${sourceButtons(block.sources, sources)}</p>
  `;
}

function renderSharedArticle(shared, token) {
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
          : t("source.viewSpotify");
  $("#episode-hero").innerHTML = html`
    ${
      episode.imageUrl
        ? html`
            <img
              src="${escapeHtml(episode.imageUrl)}"
              alt="${escapeHtml(t("source.image", { name: episode.sourceName }))}"
            />
          `
        : ""
    }
    <div>
      <span class="kicker">${escapeHtml(episode.sourceName)}</span>
      <h1>${escapeHtml(episode.title)}</h1>
      <p>
        ${escapeHtml(details.join(" · "))}${details.length ? " · " : ""}
        <a
          href="${escapeHtml(episode.sourceUrl)}"
          target="_blank"
          rel="noreferrer"
          style="color: inherit"
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
    <p class="style-note">${escapeHtml(article.styleNote)}</p>
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
  $("#audio").src = `/api/shared/${encodeURIComponent(token)}/audio`;
  $("#shared-loading").classList.add("hidden");
  $("#shared-result").classList.remove("hidden");
  articleReadingProgress.classList.remove("hidden");
  sharedReadingStorageKey = `podcast2article:reading-position:${token}`;
  resetArticleScroll();
  showContinueReading(storedReadingPosition());
  scheduleArticleReadingProgressUpdate();
}

$("#shared-main").addEventListener("click", (event) => {
  const button = event.target.closest("[data-time]");
  if (!button) {
    return;
  }
  const audio = $("#audio");
  audio.currentTime = Number(button.dataset.time);
  audio.play().catch(() => undefined);
  audio.scrollIntoView({ behavior: "smooth", block: "center" });
});

const token = location.pathname.split("/").filter(Boolean).at(-1);
localizedFetch(`/api/shared/${encodeURIComponent(token)}`)
  .then(async (response) => {
    if (!response.ok) {
      throw new Error("not found");
    }
    renderSharedArticle(await response.json(), token);
  })
  .catch(() => {
    $("#shared-loading").classList.add("hidden");
    $("#shared-error").classList.remove("hidden");
  });
