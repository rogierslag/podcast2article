import { t } from "./localize.js";

const host = document.querySelector("header.nav");
if (host) {
  const details = document.createElement("details");
  details.className = "reading-preferences";
  const summary = document.createElement("summary");
  summary.textContent = "Aa";
  summary.setAttribute("aria-label", t("reading.preferences"));
  summary.title = t("reading.preferences");
  details.append(summary);
  const panel = document.createElement("div");
  panel.className = "reading-preferences-panel";
  const heading = document.createElement("p");
  heading.className = "reading-preferences-title";
  heading.textContent = t("reading.preferences");
  panel.append(heading);
  const labels: Record<string, string> = {
    theme: t("reading.theme"),
    system: t("reading.system"),
    day: t("reading.day"),
    evening: t("reading.evening"),
    size: t("reading.size"),
    small: t("reading.small"),
    standard: t("reading.standard"),
    large: t("reading.large"),
    font: t("reading.font"),
    serif: t("reading.serif"),
    sans: t("reading.sans"),
  };
  const groups: [string, string[]][] = [
    ["theme", ["system", "day", "evening"]],
    ["size", ["small", "standard", "large"]],
    ["font", ["serif", "sans"]],
  ];
  for (const [setting, options] of groups) {
    const fieldset = document.createElement("fieldset");
    const legend = document.createElement("legend");
    legend.textContent = labels[setting] ?? setting;
    fieldset.append(legend);
    for (const option of options) {
      const label = document.createElement("label");
      const input = document.createElement("input");
      input.type = "radio";
      input.name = `reading-${setting}`;
      input.value = option;
      const key = `reading${setting.charAt(0).toUpperCase()}${setting.slice(1)}`;
      input.checked = document.documentElement.dataset[key] === option;
      input.addEventListener("change", () => {
        document.documentElement.dataset[key] = option;
        const preferences = Object.fromEntries(
          groups.map(([name]) => [
            name,
            document.documentElement.dataset[
              `reading${name.charAt(0).toUpperCase()}${name.slice(1)}`
            ],
          ]),
        );
        try {
          localStorage.setItem("p2a-reading", JSON.stringify(preferences));
        } catch {
          // The selection still applies for this page when storage is disabled.
        }
      });
      label.append(input, document.createTextNode(labels[option] ?? option));
      fieldset.append(label);
    }
    panel.append(fieldset);
  }
  const done = document.createElement("button");
  done.type = "button";
  done.textContent = t("budget.close");
  done.addEventListener("click", () => {
    details.open = false;
    summary.focus();
  });
  panel.append(done);
  details.append(panel);
  host.append(details);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && details.open) {
      details.open = false;
      summary.focus();
    }
  });
  document.addEventListener("pointerdown", (event) => {
    if (event.target instanceof Node && !details.contains(event.target)) {
      details.open = false;
    }
  });
  details.addEventListener("focusout", (event) => {
    if (
      event.relatedTarget instanceof Node &&
      !details.contains(event.relatedTarget)
    ) {
      details.open = false;
    }
  });
}
