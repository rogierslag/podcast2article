// Apply saved preferences before the first paint, including on anonymous pages.
(() => {
  let preferences = {};
  try {
    preferences = JSON.parse(localStorage.getItem("p2a-reading") || "{}") || {};
  } catch {
    // Reading remains available when browser storage is unavailable.
  }
  const theme = ["day", "evening"].includes(preferences.theme)
    ? preferences.theme
    : "system";
  const size = ["small", "standard", "large"].includes(preferences.size)
    ? preferences.size
    : "standard";
  const font = preferences.font === "sans" ? "sans" : "serif";
  document.documentElement.dataset.readingTheme = theme;
  document.documentElement.dataset.readingSize = size;
  document.documentElement.dataset.readingFont = font;
})();
