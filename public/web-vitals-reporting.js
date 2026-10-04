export function webVitalsPage(document, location) {
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

export function createWebVitalsReporter({ page, layout, release, send }) {
  const sequences = new Map();
  return (metric) => {
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
