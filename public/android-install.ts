import { requiredElement } from "./dom.js";
// Capture the browser's install event before the main application finishes loading.
(() => {
  const help = requiredElement(".android-install", HTMLElement);
  const button = requiredElement(".android-install-button", HTMLButtonElement);
  const standalone = window.matchMedia("(display-mode: standalone)");
  const isAndroid = /Android/i.test(navigator.userAgent);
  let installPrompt: { prompt: () => Promise<void> } | undefined;

  function updateVisibility() {
    help.hidden = !isAndroid || standalone.matches;
    button.hidden = help.hidden || !installPrompt;
  }

  window.addEventListener("beforeinstallprompt", (event) => {
    if (!isAndroid) {
      return;
    }
    event.preventDefault();
    if (!("prompt" in event) || typeof event.prompt !== "function") {
      return;
    }
    const prompt = event.prompt;
    installPrompt = {
      prompt: async () => {
        await prompt.call(event);
      },
    };
    updateVisibility();
  });
  window.addEventListener("appinstalled", () => {
    installPrompt = undefined;
    help.hidden = true;
    button.hidden = true;
  });
  standalone.addEventListener("change", updateVisibility);
  button.addEventListener("click", async () => {
    const prompt = installPrompt;
    if (!prompt) {
      return;
    }
    installPrompt = undefined;
    updateVisibility();
    try {
      await prompt.prompt();
    } catch {
      // The menu instructions remain available if the browser declines the prompt.
    }
  });
  updateVisibility();
})();
