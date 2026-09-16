// Keep incoming links as form data, never as navigation destinations or HTML.
export function sourcePrefill(value) {
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

export function prefillDestination(value, pathname = "/") {
  const sourceUrl = sourcePrefill(value);
  return sourceUrl
    ? `${pathname}?${new URLSearchParams({ sourceUrl })}`
    : pathname;
}

// Android often puts the link in shared text instead of the URL field.
export function sharedSourcePrefill(url, text, title) {
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
