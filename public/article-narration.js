import { language as uiLanguage, localizedFetch, t } from "./localize.js";
import { articleSpeechPassages } from "./article-speech-text.js";

export function createArticleNarration(root, beforePlay) {
  if (root.dataset.browserNarration !== "true") {
    return { load() {}, leave() {}, pauseForSource() {} };
  }
  const synth = window.speechSynthesis;
  const controls = Object.fromEntries(
    [...root.querySelectorAll("[data-narration]")].map((element) => [
      element.dataset.narration,
      element,
    ]),
  );
  const toggles = [...document.querySelectorAll("[data-listen]")];
  const rates = ["0.8", "1", "1.2", "1.5"];
  let state;
  let voices = [];
  let generation = 0;
  let utterance;
  let startTimer;
  let playing = false;
  let saveChain = Promise.resolve();
  let preferences = {};
  try {
    preferences = JSON.parse(
      localStorage.getItem("p2a:narration-preferences") || "{}",
    );
  } catch {
    /* Voice preferences are optional when browser storage is unavailable. */
  }
  if (
    !preferences ||
    typeof preferences !== "object" ||
    Array.isArray(preferences)
  ) {
    preferences = {};
  }
  controls.speed.value = rates.includes(preferences.speed)
    ? preferences.speed
    : "1";

  function savePreferences() {
    preferences.speed = controls.speed.value;
    preferences[controls.language.value] = controls.voice.value;
    try {
      localStorage.setItem(
        "p2a:narration-preferences",
        JSON.stringify(preferences),
      );
    } catch {
      /* Speech and account progress still work without local preferences. */
    }
  }

  function message(text) {
    controls.status.textContent = text;
    controls.status.hidden = !text;
  }

  function render() {
    if (!state) {
      return;
    }
    const started = Boolean(state.started || state.index);
    const percent = Math.round(
      (state.index / Math.max(1, state.passages.length)) * 100,
    );
    const label = t(
      playing
        ? "narration.pause"
        : started
          ? "narration.continue"
          : "narration.listen",
    );
    for (const button of toggles) {
      button.querySelector("span").textContent = started
        ? `${label} · ${percent}%`
        : label;
      button.setAttribute("aria-pressed", String(playing));
      button.disabled = !synth || !voices.length || !state.passages.length;
      button
        .querySelector("path")
        .setAttribute(
          "d",
          playing ? "M7 5h3v14H7zM14 5h3v14h-3z" : "m8 5 11 7-11 7z",
        );
    }
    options.hidden = !started && Boolean(synth && voices.length);
  }

  function savePosition() {
    const current = state;
    if (!current) {
      return saveChain;
    }
    const index = current.index;
    // Serialize writes, including across navigation, so a slower old request cannot overwrite a newer position.
    saveChain = saveChain.then(async () => {
      if (current.savedIndex === index) {
        if (state === current && current.index === index) {
          controls.saveError.hidden = true;
        }
        return;
      }
      try {
        const response = await localizedFetch(
          `/api/jobs/${current.job.id}/listening-position`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ version: 1, passageIndex: index }),
            keepalive: true,
          },
        );
        if (!response.ok) {
          throw new Error("listening-position");
        }
        const body = await response.json();
        current.savedIndex = index;
        current.job.listeningPosition = body.listeningPosition;
        if (state === current) {
          controls.saveError.hidden = true;
        }
      } catch {
        if (state === current) {
          controls.saveError.hidden = false;
        }
      }
    });
    return saveChain;
  }

  function cancel() {
    generation += 1;
    clearTimeout(startTimer);
    if (utterance) {
      synth?.cancel();
    }
    utterance = undefined;
    playing = false;
  }

  function pause(reason = "") {
    if (!state) {
      return;
    }
    cancel();
    void savePosition();
    message(reason);
    render();
  }

  function updateVoices() {
    if (!state) {
      return;
    }
    const selected =
      controls.voice.value || preferences[controls.language.value];
    voices =
      synth
        ?.getVoices()
        .filter(
          (voice) =>
            voice.lang.toLowerCase().split(/[-_]/)[0] ===
            controls.language.value,
        ) || [];
    voices.sort(
      (left, right) =>
        Number(right.localService) - Number(left.localService) ||
        Number(/^Daniel(?:\b|$)/i.test(right.name)) -
          Number(/^Daniel(?:\b|$)/i.test(left.name)) ||
        left.name.localeCompare(right.name),
    );
    controls.voice.replaceChildren();
    for (const voice of voices) {
      const option = document.createElement("option");
      option.value = `${voice.voiceURI}|${voice.name}|${voice.lang}`;
      option.textContent = `${voice.name} · ${voice.lang} · ${t(voice.localService ? "narration.local" : "narration.remote")}`;
      controls.voice.append(option);
    }
    if (
      [...controls.voice.options].some((option) => option.value === selected)
    ) {
      controls.voice.value = selected;
    }
    controls.unavailable.hidden = Boolean(synth && voices.length);
    controls.unavailable.textContent = t(
      synth ? "narration.noVoices" : "narration.unsupported",
    );
    render();
  }

  function speak() {
    if (
      !state ||
      !synth ||
      !voices.length ||
      !state.passages.length ||
      document.hidden
    ) {
      return;
    }
    cancel();
    beforePlay();
    if (state.index === state.passages.length) {
      state.index = 0;
    }
    const voice = voices[controls.voice.selectedIndex];
    if (!voice) {
      return;
    }
    playing = true;
    state.started = true;
    const token = generation;
    utterance = new SpeechSynthesisUtterance(state.passages[state.index]);
    utterance.voice = voice;
    utterance.lang = voice.lang;
    utterance.rate = Number(controls.speed.value);
    utterance.onstart = () => {
      if (token !== generation) {
        return;
      }
      clearTimeout(startTimer);
      message("");
    };
    utterance.onend = () => {
      if (token !== generation || !state) {
        return;
      }
      clearTimeout(startTimer);
      utterance = undefined;
      playing = false;
      state.index += 1;
      void savePosition();
      render();
      if (state.index === state.passages.length) {
        message(t("narration.complete"));
      } else if (document.hidden) {
        pause(t("narration.background"));
      } else {
        speak();
      }
    };
    utterance.onerror = () => {
      if (token === generation) {
        pause(t("narration.error"));
      }
    };
    message(t("narration.starting"));
    render();
    startTimer = setTimeout(() => {
      if (token === generation) {
        pause(t("narration.error"));
      }
    }, 8000);
    void savePosition();
    try {
      synth.speak(utterance);
    } catch {
      pause(t("narration.error"));
    }
  }

  function toggle() {
    root.hidden = false;
    if (playing) {
      pause();
    } else {
      speak();
    }
  }
  toggles.forEach((button) => button.addEventListener("click", toggle));
  controls.retry.addEventListener("click", () => {
    void savePosition();
  });
  const options = root.querySelector("details");
  options.addEventListener("toggle", () => {
    if (options.open) {
      updateVoices();
    }
  });
  root.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && options.open) {
      options.open = false;
      options.querySelector("summary").focus();
    }
  });
  document.addEventListener("click", (event) => {
    if (!options.contains(event.target)) {
      options.open = false;
    }
  });
  controls.restart.addEventListener("click", () => {
    pause();
    state.index = 0;
    state.started = false;
    void savePosition();
    render();
    options.open = false;
    toggles[0].focus();
    message("");
  });
  controls.language.addEventListener("change", () => {
    pause();
    controls.voice.replaceChildren();
    updateVoices();
  });
  for (const name of ["voice", "speed"]) {
    controls[name].addEventListener("change", () => {
      pause();
      savePreferences();
    });
  }
  synth?.addEventListener("voiceschanged", updateVoices);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && playing) {
      pause(t("narration.background"));
    }
  });
  window.addEventListener("pagehide", () => {
    if (state) {
      pause();
    }
  });
  window.addEventListener("online", () => {
    void savePosition();
  });

  return {
    load(job) {
      if (state) {
        pause();
      }
      const passages = articleSpeechPassages(job.article);
      const saved = job.listeningPosition;
      const index =
        saved?.version === 1 && Number.isSafeInteger(saved.passageIndex)
          ? Math.max(0, Math.min(saved.passageIndex, passages.length))
          : 0;
      state = { job, passages, index, savedIndex: index };
      document
        .querySelector("#article [data-article-source-count]")
        .before(root);
      root.hidden = false;
      options.open = false;
      controls.saveError.hidden = true;
      controls.language.value = ["nl", "en", "de", "fr", "es"].includes(
        job.language,
      )
        ? job.language
        : uiLanguage;
      controls.voice.replaceChildren();
      updateVoices();
      message(index === passages.length ? t("narration.complete") : "");
      render();
    },
    pauseForSource() {
      if (playing) {
        pause(t("narration.sourcePaused"));
      }
    },
    leave() {
      if (state) {
        pause();
        state = undefined;
        root.hidden = true;
      }
    },
  };
}
