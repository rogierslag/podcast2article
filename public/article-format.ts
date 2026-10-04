// Callers escape untrusted values before interpolating them into markup.
export function html(strings: TemplateStringsArray, ...values: unknown[]) {
  let markup = strings[0] ?? "";
  values.forEach((value, index) => {
    markup += String(value) + (strings[index + 1] ?? "");
  });
  return markup.trim();
}

export function escapeHtml(value: unknown = "") {
  return String(value).replace(
    /[&<>'"]/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[
        character
      ] ?? character,
  );
}

export function formatTimestamp(seconds: number) {
  const value = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const remainder = value % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
    : `${minutes}:${String(remainder).padStart(2, "0")}`;
}

export function articleSectionId(heading: string, index: number) {
  return `section-${index}-${heading
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")}`;
}
