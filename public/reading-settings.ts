// Apply saved preferences before the first paint, including on anonymous pages.
(() => {
  let preferences: Record<string, unknown> = {};
  try {
    const stored: unknown = JSON.parse(
      localStorage.getItem("p2a-reading") || "{}",
    );
    if (stored && typeof stored === "object") {
      preferences = Object.fromEntries(Object.entries(stored));
    }
  } catch {
    // Reading remains available when browser storage is unavailable.
  }
  const theme =
    typeof preferences.theme === "string" &&
    ["day", "evening"].includes(preferences.theme)
      ? preferences.theme
      : "system";
  const size =
    typeof preferences.size === "string" &&
    ["small", "standard", "large"].includes(preferences.size)
      ? preferences.size
      : "standard";
  const font = preferences.font === "sans" ? "sans" : "serif";
  document.documentElement.dataset.readingTheme = theme;
  document.documentElement.dataset.readingSize = size;
  document.documentElement.dataset.readingFont = font;
})();
