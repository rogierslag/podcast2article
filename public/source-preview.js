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
  let opener;
  let pendingPlayback;
  let playbackVersion = 0;
  let closingVersion = 0;
  let closing = false;

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
    // Keep the player in place until the exit finishes. Reduced-motion styles
    // produce no animations, so dismissal completes without a timer.
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
    resetClosing();
    cancelPendingPlayback();
    audio.pause();
    audioHome.append(audio);
    audioHome.style.minHeight = originalMinHeight;
    opener?.focus({ preventScroll: true });
    opener = undefined;
  });
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
      opener = trigger;
      metadata.textContent = speaker ? `${label} · ${speaker}` : label;
      // Only the owner supplies transcript text. Shared pages use their existing
      // minimal source payload and never request private transcript data.
      transcript.textContent = text || "";
      transcript.hidden = !text;
      status.textContent = t("sourcePreview.loading");
      audio.pause();
      audioHome.style.minHeight = `${audioHome.getBoundingClientRect().height}px`;
      player.append(audio);
      if (!dialog.open) {
        dialog.showModal();
      }
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
