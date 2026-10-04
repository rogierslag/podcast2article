import * as z from "zod/mini";
import { responseData } from "../src/shared/api.js";
import { localizedFetch, t } from "./localize.js";

const badge = document.querySelector<HTMLElement>(".article-arrivals");
let revision = 0;

async function refreshArrivals() {
  if (!badge || document.hidden) {
    return;
  }
  const currentRevision = ++revision;
  try {
    const response = await localizedFetch("/api/articles/arrivals", {
      cache: "no-store",
    });
    if (!response.ok) {
      return;
    }
    const { count } = await responseData(
      response,
      z.object({ count: z.int().check(z.nonnegative()) }),
    );
    if (currentRevision !== revision || !Number.isInteger(count) || count < 0) {
      return;
    }
    badge.hidden = count === 0;
    badge.textContent = String(count);
    badge.setAttribute("aria-label", t("nav.arrivals", { count }));
    badge.title = t("nav.arrivals", { count });
  } catch {
    // Keep the last known badge when a background refresh is unavailable.
  }
}
export async function acknowledgeArticleVisit(visitedAt?: string) {
  if (!visitedAt) {
    return;
  }
  try {
    const response = await localizedFetch("/api/articles/visit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ visitedAt }),
    });
    if (response.ok) {
      await refreshArrivals();
    }
  } catch {
    // A failed acknowledgement leaves arrivals available for the next visit.
  }
}
void refreshArrivals();
setInterval(refreshArrivals, 30000);

window.addEventListener("focus", refreshArrivals);

document.addEventListener("visibilitychange", refreshArrivals);
