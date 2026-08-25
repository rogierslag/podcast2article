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
let readingProgressFrame;

function updateArticleReadingProgress() {
  readingProgressFrame = undefined;
  const article = $("#article");
  if (
    !article ||
    articleReadingProgress.classList.contains("hidden") ||
    $("#shared-result").classList.contains("hidden")
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

  articleReadingProgress.querySelector(
    ".reading-progress-value",
  ).style.transform = `scaleX(${progressPercentage / 100})`;
  articleReadingProgress.setAttribute(
    "aria-valuenow",
    String(progressPercentage),
  );
  articleReadingProgress.setAttribute(
    "aria-valuetext",
    `${progressPercentage} procent gelezen`,
  );
}

function scheduleArticleReadingProgressUpdate() {
  if (readingProgressFrame === undefined) {
    readingProgressFrame = requestAnimationFrame(updateArticleReadingProgress);
  }
}

window.addEventListener("scroll", scheduleArticleReadingProgressUpdate, {
  passive: true,
});
window.addEventListener("resize", scheduleArticleReadingProgressUpdate);

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
                  title="Luister vanaf ${time(source.start)}"
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

function renderSharedArticle(shared, token) {
  const { episode, article, sources } = shared;
  const details = [
    episode.publishedAt
      ? new Date(episode.publishedAt).toLocaleDateString("nl-NL", {
          dateStyle: "long",
        })
      : "",
    episode.durationSeconds
      ? `${Math.round(episode.durationSeconds / 60)} minuten`
      : "",
  ].filter(Boolean);
  const sourceLabel =
    episode.sourceType === "google-drive"
      ? "Bekijk in Google Drive ↗"
      : episode.sourceType === "youtube"
        ? "Bekijk op YouTube ↗"
        : "Bekijk op Spotify ↗";
  $("#episode-hero").innerHTML = html`
    ${episode.imageUrl
      ? html`
          <img
            src="${escapeHtml(episode.imageUrl)}"
            alt="Afbeelding van ${escapeHtml(episode.sourceName)}"
          />
        `
      : ""}
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
            .map(
              (paragraph) => html`
                <p>
                  ${escapeHtml(paragraph.text)}
                  ${sourceButtons(paragraph.sources, sources)}
                </p>
              `,
            )
            .join("")}
        </section>
      `;
    })
    .join("");
  $("#article").innerHTML = html`
    <h1>${escapeHtml(article.title)}</h1>
    <p class="dek">${escapeHtml(article.dek)}</p>
    <p class="byline">
      ${article.readingTimeMinutes} minuten leestijd · anoniem gedeeld
    </p>
    <p class="style-note">${escapeHtml(article.styleNote)}</p>
    ${sections}
    <div class="takeaways">
      <h2>Kernpunten</h2>
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
fetch(`/api/shared/${encodeURIComponent(token)}`)
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
