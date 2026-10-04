import { onCLS, onINP, onLCP } from "/vendor/web-vitals.js";
import {
  createWebVitalsReporter,
  webVitalsPage,
} from "./web-vitals-reporting.js";

if (navigator.webdriver !== true) {
  const report = createWebVitalsReporter({
    page: webVitalsPage(document, location),
    layout: matchMedia("(max-width: 799px)").matches ? "narrow" : "wide",
    release:
      document.querySelector('meta[name="app-release"]')?.content || null,
    send: (measurement) => {
      // Telemetry is best-effort and must never interrupt reading or send session cookies.
      void fetch("/api/web-vitals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "omit",
        referrerPolicy: "no-referrer",
        keepalive: true,
        body: JSON.stringify(measurement),
      }).catch(() => undefined);
    },
  });
  onCLS(report);
  onINP(report);
  onLCP(report);
}
