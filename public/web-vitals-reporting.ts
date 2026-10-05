import type { Metric } from "web-vitals";
export interface VitalsMeasurement {
  name: string;
  value: number;
  id: string;
  sequence: number;
  navigationType: Metric["navigationType"];
  page: string | undefined;
  layout: string;
  release: string | null;
}
export function webVitalsPage(
  document: Pick<Document, "documentElement">,
  location: Pick<Location, "pathname" | "hash">,
) {
  const templatePage = document.documentElement.dataset.vitalsPage;
  if (templatePage !== "owner") {
    return templatePage;
  }
  if (location.pathname === "/articles") {
    return "articles";
  }
  if (new URLSearchParams(location.hash.slice(1)).has("job")) {
    return "article";
  }
  return "new-article";
}

export function createWebVitalsReporter({
  page,
  layout,
  release,
  send,
}: {
  page: string | undefined;
  layout: string;
  release: string | null;
  send: (measurement: VitalsMeasurement) => void;
}) {
  const sequences = new Map<string, number>();
  return (metric: Pick<Metric, "id" | "name" | "value" | "navigationType">) => {
    const sequence = (sequences.get(metric.id) ?? 0) + 1;
    sequences.set(metric.id, sequence);
    // Send only the measurement; entries and attribution can contain private URLs or text.
    send({
      name: metric.name,
      value: metric.value,
      id: metric.id,
      sequence,
      navigationType: metric.navigationType,
      page,
      layout,
      release,
    });
  };
}
