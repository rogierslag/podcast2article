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
    throw new Error("Je sessie is verlopen. Log opnieuw in.");
  }
  return response;
};
const landing = $("#landing");
const articlesView = $("#articles-view");
const progressView = $("#progress-view");
const resultView = $("#result-view");
const form = $("#job-form");
let currentJob;
let articlesState = [];
let processingState = [];
let overviewRefreshTimer;

fetch("/api/auth")
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
  queued: "In wachtrij",
  resolving: "Bron controleren",
  downloading: "Downloaden",
  transcribing: "Transcriberen",
  writing: "Artikel schrijven",
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

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  $("#form-error").textContent = "";
  const data = Object.fromEntries(new FormData(form));
  try {
    const response = await fetch("/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    const body = await response.json();
    if (!response.ok) {
      throw new Error(body.error || "De opdracht kon niet starten.");
    }
    location.hash = `job=${body.id}`;
    showProgress(body);
    poll(body.id);
  } catch (error) {
    $("#form-error").textContent = error.message;
  }
});

function showProgress(job) {
  landing.classList.add("hidden");
  articlesView.classList.add("hidden");
  resultView.classList.add("hidden");
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
    const response = await fetch(`/api/jobs/${id}`);
    if (!response.ok) {
      throw new Error("Opdracht niet gevonden.");
    }
    const job = await response.json();
    showProgress(job);
    if (job.stage === "complete") {
      return renderResult(job);
    }
    if (job.stage === "failed") {
      throw new Error(job.error || "Verwerking mislukt.");
    }
    setTimeout(() => poll(id), 1800);
  } catch (error) {
    progressView.classList.add("hidden");
    landing.classList.remove("hidden");
    $("#form-error").textContent = error.message;
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
                  title="Ga naar transcript op ${time(item.start)}"
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
  const episode = job.episode,
    article = job.article,
    transcript = job.transcript;
  const sourceName =
    episode.sourceName || episode.podcast || "Oorspronkelijke bron";
  const sourceUrl = episode.sourceUrl || episode.spotifyUrl;
  const sourceLinkLabel =
    episode.sourceType === "google-drive"
      ? "Bekijk in Google Drive ↗"
      : episode.sourceType === "youtube"
        ? "Bekijk op YouTube ↗"
        : "Bekijk op Spotify ↗";
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
  $("#episode-hero").innerHTML = html`
    ${episode.imageUrl
      ? html`
          <img
            src="${escapeHtml(episode.imageUrl)}"
            alt="Afbeelding van ${escapeHtml(sourceName)}"
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
            .map(
              (paragraph) => html`
                <p>
                  ${escapeHtml(paragraph.text)}
                  ${sourceButtons(paragraph.sources, transcript)}
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
      ${article.readingTimeMinutes} minuten leestijd · gebaseerd op
      ${transcript.length} bronfragmenten
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
  window.scrollTo({ top: 0 });
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
      label.textContent = "PDF maken…";
    }
  });
  setArticleActionStatus("");
  try {
    const response = await fetch(`/api/jobs/${job.id}/pdf`);
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || "PDF-export is mislukt.");
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    const title =
      job.article.title
        .replace(/[\\/:*?\"<>|]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 120) || "artikel";
    link.href = url;
    link.download = `${title}.pdf`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setArticleActionStatus("PDF gedownload.", true);
  } catch (error) {
    setArticleActionStatus(error.message);
  } finally {
    buttons.forEach((button) => {
      button.disabled = false;
      const label = button.querySelector("span");
      if (label) {
        label.textContent = "Download PDF";
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
    throw new Error("Kopiëren is niet gelukt.");
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
    const response = await fetch(`/api/jobs/${currentJob.id}/share`, {
      method: "POST",
    });
    const body = await response.json();
    if (!response.ok) {
      throw new Error(body.error || "Permalink kon niet worden aangemaakt.");
    }
    if (matchMedia("(max-width: 600px)").matches && navigator.share) {
      try {
        await navigator.share({
          title: currentJob.article.title,
          text: `Lees “${currentJob.article.title}” op Podcast2Article: ${body.url}`,
          url: body.url,
        });
        setArticleActionStatus("Artikel gedeeld.", true);
        return;
      } catch (error) {
        if (error?.name === "AbortError") {
          return;
        }
      }
    }
    await copyToClipboard(body.url);
    setArticleActionStatus("Deelbare link gekopieerd.", true);
  } catch (error) {
    setArticleActionStatus(error.message);
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
    ? "Toon"
    : "Verberg";
});
document
  .querySelectorAll("[data-pdf-export]")
  .forEach((button) => button.addEventListener("click", exportToPdf));
document
  .querySelectorAll("[data-share-article]")
  .forEach((button) => button.addEventListener("click", shareArticle));

async function updateArticleRead(id, read) {
  const response = await fetch(`/api/articles/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ read }),
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(body.error || "Leesstatus kon niet worden opgeslagen.");
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
      isRead ? "Zet artikel terug op ongelezen" : "Markeer artikel als gelezen",
    );
    button.querySelector("span").textContent = isRead
      ? "Gelezen"
      : "Markeer als gelezen";
  });
}

async function toggleCurrentArticleRead() {
  if (!currentJob) {
    return;
  }
  const buttons = document.querySelectorAll("[data-article-read-toggle]");
  buttons.forEach((button) => {
    button.disabled = true;
  });
  setArticleActionStatus("");
  try {
    const article = await updateArticleRead(currentJob.id, !currentJob.readAt);
    currentJob.readAt = article.readAt;
    updateReadButtons();
  } catch (error) {
    setArticleActionStatus(error.message);
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
  return new Date(value).toLocaleDateString("nl-NL", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

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
        aria-label="Lees ${escapeHtml(article.title)}"
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
          min.
        </p>
        <a class="article-card-title" href="${articleUrl}">
          <h3>${escapeHtml(article.title)}</h3>
        </a>
        <p class="article-card-dek">${escapeHtml(article.dek)}</p>
        <div class="article-card-footer">
          <span>${escapeHtml(article.sourceName)}</span>
          <div class="article-card-actions">
            <a href="${articleUrl}"> Lees <span aria-hidden="true">→</span> </a>
            <button
              type="button"
              data-read-toggle
              data-article-id="${articleId}"
              data-read="${isRead}"
              aria-label="${isRead
                ? "Zet op ongelezen"
                : "Markeer als gelezen"}"
              aria-pressed="${isRead}"
            >
              <svg aria-hidden="true" viewBox="0 0 24 24">
                <path d="m5 12 4 4L19 6" />
              </svg>
              ${isRead ? "Gelezen" : "Markeer gelezen"}
            </button>
          </div>
        </div>
      </div>
    </article>
  `;
}

function articleShelf(title, articles, emptyText) {
  return html`
    <section class="article-shelf">
      <div class="article-shelf-heading">
        <h2>${title}</h2>
        <span>${articles.length}</span>
      </div>
      ${articles.length
        ? html`
            <div class="articles-grid">
              ${articles.map(articleCard).join("")}
            </div>
          `
        : html`<p class="article-shelf-empty">${emptyText}</p>`}
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
          aria-label="${Math.round(job.progress)} procent voltooid"
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
        <h2>In verwerking</h2>
        <span>${processingState.length}</span>
      </div>
      ${processingState.length
        ? html`
            <div class="processing-grid">
              ${processingState.map(processingCard).join("")}
            </div>
          `
        : html`
            <p class="article-shelf-empty">
              Er wordt op dit moment niets verwerkt.
            </p>
          `}
    </section>
  `;
}

function renderArticlesOverview() {
  articlesState.sort(compareArticlesForOverview);
  const unread = articlesState.filter((article) => !article.readAt);
  const read = articlesState.filter((article) => article.readAt);
  if (articlesState.length === 0 && processingState.length === 0) {
    $("#articles-count").textContent = "0 artikelen";
    $("#articles-content").innerHTML = processingShelf();
    $("#articles-empty").classList.remove("hidden");
    return;
  }
  $("#articles-count").textContent =
    `${processingState.length} in verwerking · ${unread.length} nog te lezen · ${read.length} gelezen`;
  $("#articles-content").innerHTML =
    processingShelf() +
    articleShelf("Nog te lezen", unread, "Je bent helemaal bij.") +
    articleShelf("Gelezen", read, "Nog geen artikelen afgevinkt.");
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
    $("#articles-error").textContent = error.message;
    button.disabled = false;
  }
});

async function showArticles(showLoading = true) {
  landing.classList.add("hidden");
  progressView.classList.add("hidden");
  resultView.classList.add("hidden");
  articlesView.classList.remove("hidden");
  if (showLoading) {
    $("#articles-content").innerHTML = html`
      <p class="articles-loading">Artikelen ophalen…</p>
    `;
    $("#articles-empty").classList.add("hidden");
  }
  $("#articles-error").textContent = "";
  try {
    const [articlesResponse, processingResponse] = await Promise.all([
      fetch("/api/articles"),
      fetch("/api/jobs"),
    ]);
    if (!articlesResponse.ok || !processingResponse.ok) {
      throw new Error("Het overzicht kon niet worden opgehaald.");
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
    $("#articles-error").textContent = error.message;
  }
}

const hashParameters = new URLSearchParams(location.hash.slice(1));
const hashJob = hashParameters.get("job");
if (hashJob && /^[0-9a-f-]{36}$/i.test(hashJob)) {
  poll(hashJob);
} else if (location.pathname.replace(/\/$/, "") === "/articles") {
  showArticles();
}
