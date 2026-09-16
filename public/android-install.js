// Capture the browser's install event before the main application finishes loading.
(() => {
  const help = document.querySelector(".android-install");
  const button = document.querySelector(".android-install-button");
  const standalone = window.matchMedia("(display-mode: standalone)");
  const isAndroid = /Android/i.test(navigator.userAgent);
  let installPrompt;

  function updateVisibility() {
    help.hidden = !isAndroid || standalone.matches;
    button.hidden = help.hidden || !installPrompt;
  }

  window.addEventListener("beforeinstallprompt", (event) => {
    if (!isAndroid) {
      return;
    }
    event.preventDefault();
    installPrompt = event;
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
