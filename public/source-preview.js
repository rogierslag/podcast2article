import { t } from "./localize.js";

// Reuse the page's audio element so opening a citation cannot start a second player.
export function createSourcePreview(dialog, audio) {
  const audioHome = audio.parentElement;
  const originalMinHeight = audioHome.style.minHeight;
  const player = dialog.querySelector("[data-preview-player]");
  const metadata = dialog.querySelector("[data-preview-metadata]");
  const transcript = dialog.querySelector("[data-preview-transcript]");
  const status = dialog.querySelector("[data-preview-status]");
  const closeButton = dialog.querySelector("[data-preview-close]");
  const document = dialog.ownerDocument;
  const view = document?.defaultView;
  const desktop = view?.matchMedia("(min-width: 1280px)");
  let opener;
  let activeParagraph;
  let pendingPlayback;
  let playbackVersion = 0;
  let closingVersion = 0;
  let closing = false;
  let isModal = true;

  function clearReference() {
    opener?.setAttribute?.("aria-expanded", "false");
    activeParagraph?.classList.remove("source-preview-active");
    activeParagraph = undefined;
  }

  function sidePanelWidth() {
    if (!desktop?.matches || !view) {
      return 0;
    }
    const article = document.querySelector("#article");
    const articleRight =
      article?.getBoundingClientRect().right ?? view.innerWidth - 360;
    // Leave a clear gap next to the article and never squeeze source text into a narrow rail.
    const availableWidth = view.innerWidth - articleRight - 40;
    return availableWidth >= 240 ? Math.min(320, availableWidth) : 0;
  }

  function positionPanel() {
    if (!dialog.open || isModal || !opener || !view) {
      return;
    }
    dialog.style.width = `${sidePanelWidth()}px`;
    const panelHeight = dialog.getBoundingClientRect().height;
    const maximumTop = Math.max(88, view.innerHeight - panelHeight - 20);
    const referenceTop = opener.getBoundingClientRect().top;
    dialog.style.top = `${Math.min(maximumTop, Math.max(88, referenceTop))}px`;
  }

  function showPanel() {
    const nonmodal = sidePanelWidth() > 0;
    isModal = !nonmodal;
    dialog.classList.toggle("is-source-modal", !nonmodal);
    dialog.setAttribute("aria-modal", String(!nonmodal));
    if (nonmodal) {
      dialog.show();
      positionPanel();
    } else {
      dialog.style.width = "";
      dialog.style.top = "";
      dialog.showModal();
    }
  }

  function cancelPendingPlayback() {
    playbackVersion += 1;
    if (pendingPlayback) {
      audio.removeEventListener("loadedmetadata", pendingPlayback);
      pendingPlayback = undefined;
    }
  }

  function playFrom(start) {
    cancelPendingPlayback();
    const version = playbackVersion;
    const play = () => {
      pendingPlayback = undefined;
      if (!dialog.open || closing || version !== playbackVersion) {
        return;
      }
      audio.currentTime = start;
      audio.play().catch(() => {
        if (dialog.open && version === playbackVersion) {
          status.textContent = t("sourcePreview.playManually");
        }
      });
    };
    if (audio.readyState >= 1) {
      play();
    } else {
      pendingPlayback = play;
      audio.addEventListener("loadedmetadata", play, { once: true });
      audio.load();
    }
  }

  function resetClosing() {
    closingVersion += 1;
    closing = false;
    dialog.classList.remove("is-closing");
  }

  async function dismiss() {
    if (!dialog.open || closing) {
      return;
    }
    closing = true;
    const version = ++closingVersion;
    cancelPendingPlayback();
    audio.pause();
    dialog.classList.add("is-closing");
    // Keep the player in place until the exit finishes.
    // Reduced-motion styles produce no animations, so dismissal completes without a timer.
    await Promise.all(
      dialog.getAnimations().map((animation) =>
        animation.finished.catch(() => {
          // Closing directly or reopening may cancel an in-flight animation.
        }),
      ),
    );
    if (closing && version === closingVersion && dialog.open) {
      dialog.close();
    }
  }

  closeButton.addEventListener("click", dismiss);
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    void dismiss();
  });
  dialog.addEventListener("close", () => {
    // Native close events are queued and can arrive after another citation has opened.
    if (dialog.open) {
      return;
    }
    resetClosing();
    clearReference();
    cancelPendingPlayback();
    audio.pause();
    audioHome.append(audio);
    audioHome.style.minHeight = originalMinHeight;
    opener?.focus({ preventScroll: true });
    opener = undefined;
  });
  document?.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && dialog.open && desktop?.matches) {
      event.preventDefault();
      void dismiss();
    }
  });
  document?.addEventListener("scroll", positionPanel, {
    capture: true,
    passive: true,
  });
  function adaptPanel() {
    if (!dialog.open) {
      return;
    }
    if (isModal === (sidePanelWidth() === 0)) {
      positionPanel();
      return;
    }
    resetClosing();
    dialog.close();
    showPanel();
    closeButton.focus({ preventScroll: true });
  }
  view?.addEventListener("resize", adaptPanel);
  desktop?.addEventListener("change", adaptPanel);
  audio.addEventListener("error", () => {
    if (dialog.open) {
      status.textContent = t("sourcePreview.audioError");
    }
  });
  audio.addEventListener("playing", () => {
    status.textContent = "";
  });

  return {
    open({ start, label, speaker, text }, trigger) {
      if (!Number.isFinite(start) || start < 0) {
        return;
      }
      resetClosing();
      clearReference();
      opener = trigger;
      opener?.setAttribute?.("aria-expanded", "true");
      activeParagraph = opener?.closest?.("p, blockquote, li");
      activeParagraph?.classList.add("source-preview-active");
      metadata.textContent = speaker ? `${label} · ${speaker}` : label;
      // Only the owner supplies transcript text.
      // Shared pages use their existing minimal source payload and never request private transcript data.
      transcript.textContent = text || "";
      transcript.hidden = !text;
      status.textContent = t("sourcePreview.loading");
      audio.pause();
      audioHome.style.minHeight = `${audioHome.getBoundingClientRect().height}px`;
      player.append(audio);
      if (!dialog.open) {
        showPanel();
      }
      positionPanel();
      closeButton.focus({ preventScroll: true });
      playFrom(start);
    },
    close() {
      if (dialog.open) {
        dialog.close();
      }
    },
  };
}
