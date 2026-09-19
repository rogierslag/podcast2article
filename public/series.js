import {
  t,
  locale,
  localizedFetch,
  LocalizedError,
  errorText,
} from "./localize.js";
const searchForm = document.querySelector("#series-search");
const followForm = document.querySelector("#series-follow");
const sourceInput = document.querySelector("#series-url");
const errorMessage = document.querySelector("#series-error");
errorMessage.tabIndex = -1;
const previewSection = document.querySelector("#series-preview");
const candidateSection = document.querySelector("#series-candidates");
const subscriptionList = document.querySelector("#series-list");
const statusMessage = document.querySelector("#series-status");
const backfillSelect = document.querySelector("#series-backfill");
let preview;
let busy = false;

async function api(url, method = "GET", body) {
  const response = await localizedFetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (response.status === 401) {
    location.assign("/login");
    throw new LocalizedError(t("error.sessionExpired"));
  }
  const result = await response.json();
  if (!response.ok) {
    throw new LocalizedError(result.error || t("error.generic"));
  }
  return result;
}

function element(tag, content, className) {
  const node = document.createElement(tag);
  if (content) {
    node.textContent = content;
  }
  if (className) {
    node.className = className;
  }
  return node;
}

function seriesCover(imageUrl) {
  const cover = element("span", "", "series-cover");
  cover.setAttribute("aria-hidden", "true");
  cover.append(element("span", "♪", "series-cover-placeholder"));
  if (typeof imageUrl !== "string") {
    return cover;
  }
  try {
    const url = new URL(imageUrl);
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password
    ) {
      return cover;
    }
    const image = document.createElement("img");
    image.alt = "";
    image.width = 80;
    image.height = 80;
    image.loading = "lazy";
    image.referrerPolicy = "no-referrer";
    image.addEventListener("error", () => image.remove(), { once: true });
    image.src = url.href;
    cover.append(image);
  } catch {
    // Missing or malformed artwork must not prevent following a series.
  }
  return cover;
}

async function perform(action) {
  if (busy) {
    return;
  }
  busy = true;
  errorMessage.textContent = "";
  document.querySelectorAll(".series-page button").forEach((button) => {
    button.disabled = true;
  });
  try {
    await action();
  } catch (error) {
    errorMessage.textContent = errorText(error);
    errorMessage.focus();
  } finally {
    busy = false;
    document.querySelectorAll(".series-page button").forEach((button) => {
      button.disabled = button.dataset.limitDisabled === "true";
    });
  }
}

function updatePlan() {
  if (!preview) {
    return;
  }
  const choice = backfillSelect.value;
  const count = choice === "none" ? 0 : Math.min(preview.count, 3);
  document.querySelector("#series-plan").textContent = t(
    count === 1 ? "series.planOne" : "series.plan",
    { count },
  );
}

async function showPreview(url) {
  preview = await api("/api/subscriptions/preview", "POST", { url });
  candidateSection.hidden = true;
  previewSection.hidden = false;
  const heading = document.querySelector("#series-preview-title");
  heading.textContent = preview.title;
  document
    .querySelector("#series-preview-cover")
    .replaceChildren(seriesCover(preview.imageUrl));
  document.querySelector("#series-feed-link").href = preview.url;
  document.querySelector("#series-available").textContent = t(
    "series.available",
    { count: preview.count },
  );
  document
    .querySelector("#series-episodes")
    .replaceChildren(
      ...preview.episodes.map((episode) => element("li", episode.title)),
    );
  updatePlan();
  heading.focus();
}

searchForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void perform(async () => {
    preview = undefined;
    previewSection.hidden = true;
    candidateSection.hidden = true;
    const candidates = await api("/api/subscriptions/discover", "POST", {
      url: sourceInput.value,
    });
    if (candidates.length === 1) {
      await showPreview(candidates[0].url);
      return;
    }
    const list = document.querySelector("#series-candidate-list");
    list.replaceChildren(
      ...candidates.map((candidate) => {
        const button = element("button", "", "series-candidate");
        button.append(
          seriesCover(candidate.imageUrl),
          element(
            "span",
            `${candidate.title}${candidate.author ? ` · ${candidate.author}` : ""}`,
          ),
        );
        button.type = "button";
        button.addEventListener(
          "click",
          () => void perform(() => showPreview(candidate.url)),
        );
        return button;
      }),
    );
    candidateSection.hidden = false;
  });
});
backfillSelect.addEventListener("change", updatePlan);
followForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!preview) {
    return;
  }
  void perform(async () => {
    await api("/api/subscriptions", "POST", {
      ...Object.fromEntries(new FormData(followForm)),
      previewId: preview.id,
    });
    previewSection.hidden = true;
    preview = undefined;
    sourceInput.value = "";
    statusMessage.textContent = t("series.saved");
    await refresh();
    document
      .querySelector("#series-following-title")
      .scrollIntoView({ block: "start" });
  });
});

async function refresh() {
  const subscriptions = await api("/api/subscriptions");
  document.querySelector("#series-count").textContent = t("series.total", {
    count: subscriptions.length,
  });
  if (!subscriptions.length) {
    subscriptionList.replaceChildren(
      element("p", t("series.empty"), "series-hint"),
    );
    return;
  }
  subscriptionList.replaceChildren(
    ...subscriptions.map((subscription) => {
      const row = element("article", "", "series-item");
      row.dataset.subscriptionId = subscription.id;
      row.id = `subscription-${subscription.id}`;
      row.tabIndex = -1;
      const content = element("div");
      content.append(element("h3", subscription.title));
      content.append(
        element(
          "p",
          t(subscription.paused ? "series.paused" : "series.active"),
          "series-state",
        ),
      );
      content.append(
        element(
          "p",
          t("series.counts", {
            complete: subscription.complete,
            processing: subscription.processing,
            pending: subscription.pendingCount,
          }),
        ),
      );
      content.append(
        element(
          "p",
          t("series.outstanding", { count: subscription.outstanding || 0 }),
        ),
      );
      if (subscription.pauseReason === "limit") {
        content.append(
          element("p", t("series.limitPaused"), "series-limit-note"),
        );
      }
      if (subscription.checkedAt) {
        content.append(
          element(
            "p",
            t("series.checked", {
              date: new Date(subscription.checkedAt).toLocaleString(locale, {
                dateStyle: "short",
                timeStyle: "short",
              }),
            }),
          ),
        );
      }
      if (subscription.error) {
        content.append(
          element(
            "p",
            t(
              subscription.error === "error.creationUnavailable"
                ? "error.creationUnavailable"
                : "series.errorCheck",
            ),
            "error",
          ),
        );
      }
      for (const failed of subscription.failed) {
        const link = element("a", t("series.failed", { title: failed.title }));
        link.href = `/#job=${encodeURIComponent(failed.id)}`;
        const paragraph = element("p");
        paragraph.append(link);
        content.append(paragraph);
      }
      const button = element(
        "button",
        t(subscription.paused ? "series.resume" : "series.pause"),
        "series-control",
      );
      button.type = "button";
      button.dataset.limitDisabled = String(
        subscription.paused && subscription.outstanding >= 5,
      );
      button.disabled = button.dataset.limitDisabled === "true";
      button.setAttribute(
        "aria-label",
        `${button.textContent}: ${subscription.title}`,
      );
      button.addEventListener(
        "click",
        () =>
          void perform(async () => {
            await api(`/api/subscriptions/${subscription.id}`, "PATCH", {
              paused: !subscription.paused,
            });
            statusMessage.textContent = t(
              subscription.paused ? "series.resumed" : "series.pauseInfo",
            );
            await refresh();
            // Rendering replaces the button; keep keyboard users on the same action.
            [...subscriptionList.querySelectorAll("button")]
              .find(
                (control) =>
                  control.closest(".series-item")?.dataset.subscriptionId ===
                  subscription.id,
              )
              ?.focus();
          }),
      );
      const controls = element("div", "", "series-controls");
      controls.append(button);
      if (subscription.archiveCount > 0) {
        const count = Math.max(
          0,
          Math.min(
            3,
            subscription.archiveCount,
            5 - (subscription.outstanding || 0) - subscription.pendingCount,
          ),
        );
        const more = element(
          "button",
          t(count === 0 ? "series.moreLater" : "series.more", { count }),
          "series-control",
        );
        more.type = "button";
        more.dataset.limitDisabled = String(count === 0);
        more.disabled = count === 0;
        more.setAttribute(
          "aria-label",
          `${more.textContent}: ${subscription.title}`,
        );
        more.addEventListener(
          "click",
          () =>
            void perform(async () => {
              const result = await api(
                `/api/subscriptions/${subscription.id}/backfill`,
                "POST",
                {},
              );
              statusMessage.textContent = t("series.moreSaved", {
                count: result.count,
              });
              await refresh();
            }),
        );
        controls.append(more);
      }
      const identity = element("div", "", "series-identity");
      identity.append(seriesCover(subscription.imageUrl), content);
      row.append(identity, controls);
      return row;
    }),
  );
}

void perform(async () => {
  await refresh();
  if (location.hash.startsWith("#subscription-")) {
    document.getElementById(location.hash.slice(1))?.focus();
  }
  const params = new URLSearchParams(location.search);
  if (params.get("preview") === "1" && params.get("url")) {
    backfillSelect.value = "none";
    await showPreview(params.get("url"));
  }
});
const prefilledUrl = new URLSearchParams(location.search).get("url");
if (prefilledUrl) {
  sourceInput.value = prefilledUrl;
}
void api("/api/auth")
  .then((session) => {
    document
      .querySelector("#logout-form")
      .classList.toggle("is-unavailable", !session.enabled);
  })
  .catch(() => undefined);

const refreshTimer = setInterval(() => {
  if (
    !busy &&
    !document.hidden &&
    !subscriptionList.contains(document.activeElement)
  ) {
    void refresh().catch((error) => {
      errorMessage.textContent = errorText(error);
    });
  }
}, 10000);
window.addEventListener("pagehide", () => clearInterval(refreshTimer));
sourceInput.addEventListener("input", () => {
  preview = undefined;
  previewSection.hidden = true;
  candidateSection.hidden = true;
});
