// Keep incoming links as form data, never as navigation destinations or HTML.
export function seriesEpisodePrefill(value: unknown) {
  if (typeof value !== "string") {
    return undefined;
  }
  const match =
    /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):([a-zA-Z0-9_-]{1,200})$/i.exec(
      value,
    );
  const subscriptionId = match?.[1];
  const episodeKey = match?.[2];
  return subscriptionId && episodeKey
    ? { subscriptionId, episodeKey }
    : undefined;
}

export function seriesEpisodeReference(value: unknown): string {
  const episode = seriesEpisodePrefill(value);
  return episode ? `${episode.subscriptionId}:${episode.episodeKey}` : "";
}

export function sourcePrefill(value: unknown) {
  if (typeof value !== "string" || value.length > 500) {
    return "";
  }
  try {
    const url = new URL(value);
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password
    ) {
      return "";
    }
    return value;
  } catch {
    return "";
  }
}

export function prefillDestination(
  value: unknown,
  pathname: "/" | "/login" = "/",
  episodeReference?: unknown,
) {
  const sourceUrl = sourcePrefill(value);
  const seriesEpisode = seriesEpisodeReference(episodeReference);
  const parameters = new URLSearchParams();
  if (sourceUrl) {
    parameters.set("sourceUrl", sourceUrl);
  }
  if (seriesEpisode) {
    parameters.set("seriesEpisode", seriesEpisode);
  }
  return parameters.size ? `${pathname}?${parameters}` : pathname;
}

// Android often puts the link in shared text instead of the URL field.
export function sharedSourcePrefill(
  url: unknown,
  text: unknown,
  title: unknown,
) {
  const directUrl = sourcePrefill(url);
  if (directUrl) {
    return directUrl;
  }
  for (const value of [text, title]) {
    if (typeof value !== "string" || value.length > 4000) {
      continue;
    }
    const directText = sourcePrefill(value.trim());
    if (directText && !/\s/.test(value.trim())) {
      return directText;
    }
    const links = value.match(/https?:\/\/[^\s<>"']+/g) ?? [];
    // Do not guess which episode the user meant when multiple links are shared.
    if (links.length === 1) {
      return sourcePrefill(links[0]);
    }
  }
  return "";
}
