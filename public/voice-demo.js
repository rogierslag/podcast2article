const uiLanguage = navigator.language.toLowerCase().startsWith("nl")
  ? "nl"
  : "en";
const copy = {
  en: {
    title: "Find your reading voice.",
    intro:
      "Try the voices on this device, then take a longer passage for a walk.",
    notice:
      "No paid API is used. Local voices run on your device; remote voices may send text to the browser’s speech provider. Progress stays in this browser.",
    language: "Text language",
    voice: "Voice",
    speed: "Speed",
    refresh: "Refresh voices",
    preview: "Preview voice",
    text: "Your test passage",
    sample: "Load sample",
    long: "Load long test",
    play: "Listen / continue",
    pause: "Pause",
    previous: "Previous passage",
    next: "Next passage",
    restart: "Restart",
    testTitle: "Try an interruption.",
    testBody:
      "Start the long test, lock your phone for 30 seconds, switch apps, then return. Does speech continue? Can you resume? Reload this page to test saved progress. Pause deliberately stops speech; Continue repeats the current passage.",
    diagnostics: "Device and playback log",
    logHelp:
      "Copy this log after a test to compare devices. It includes device details, voice names and events, but not your passage text.",
    copy: "Copy log",
    ready: "Ready when you are.",
    starting: "Waiting for speech to start…",
    playing: "Reading aloud",
    paused: "Paused. Continue repeats this passage.",
    complete: "Finished.",
    empty: "Add some text first.",
    unsupported: "This browser does not support speech synthesis.",
    noVoices: "No matching voices yet. Try Refresh voices.",
    local: "Local",
    remote: "Remote",
    saved: "Saved position restored.",
    storage: "Browser storage is unavailable; progress cannot be saved.",
    copied: "Log copied.",
    copyFailed: "Could not copy. Select the log below instead.",
    stalled:
      "No speech-start event received. Try another voice or tap Listen again.",
    error: "Speech failed",
    progress: "passages completed",
    playback: "Playback",
    completed: "Completed passages",
  },
  nl: {
    title: "Vind je voorleesstem.",
    intro:
      "Probeer de stemmen op dit apparaat en neem daarna een langere tekst mee voor een wandeling.",
    notice:
      "Er wordt geen betaalde API gebruikt. Lokale stemmen werken op je apparaat; externe stemmen kunnen tekst naar de spraakdienst van je browser sturen. Je voortgang blijft in deze browser.",
    language: "Taal van de tekst",
    voice: "Stem",
    speed: "Snelheid",
    refresh: "Stemmen vernieuwen",
    preview: "Stem beluisteren",
    text: "Je testtekst",
    sample: "Voorbeeld laden",
    long: "Lange test laden",
    play: "Luisteren / doorgaan",
    pause: "Pauzeren",
    previous: "Vorige passage",
    next: "Volgende passage",
    restart: "Opnieuw",
    testTitle: "Probeer een onderbreking.",
    testBody:
      "Start de lange test, vergrendel je telefoon 30 seconden, wissel van app en keer terug. Gaat het voorlezen door? Kun je verder luisteren? Herlaad deze pagina om opgeslagen voortgang te testen. Pauzeren stopt de stem; Doorgaan herhaalt de huidige passage.",
    diagnostics: "Apparaat en afspeellog",
    logHelp:
      "Kopieer dit log na een test om apparaten te vergelijken. Het bevat apparaatgegevens, stemnamen en gebeurtenissen, maar niet je testtekst.",
    copy: "Log kopiëren",
    ready: "Klaar om te luisteren.",
    starting: "Wachten tot de stem begint…",
    playing: "Aan het voorlezen",
    paused: "Gepauzeerd. Doorgaan herhaalt deze passage.",
    complete: "Klaar.",
    empty: "Voeg eerst tekst toe.",
    unsupported: "Deze browser ondersteunt geen spraaksynthese.",
    noVoices: "Nog geen passende stemmen. Probeer Stemmen vernieuwen.",
    local: "Lokaal",
    remote: "Extern",
    saved: "Opgeslagen voortgang hersteld.",
    storage:
      "Browseropslag is niet beschikbaar; voortgang kan niet worden bewaard.",
    copied: "Log gekopieerd.",
    copyFailed: "Kopiëren mislukt. Selecteer het log hieronder.",
    stalled:
      "Geen startmelding ontvangen. Probeer een andere stem of tik opnieuw op Luisteren.",
    error: "Voorlezen mislukt",
    progress: "passages voltooid",
    playback: "Afspelen",
    completed: "Voltooide passages",
  },
};
const samples = {
  en: "A little more room to think.\n\nOn a quiet morning, a researcher walks to the station without checking her phone. The city is already awake, but she notices things she normally misses: a bicycle bell, fresh bread, and sunlight on the canal.\n\nIn our conversation, she described why attention needs space. A short break does not solve every difficult problem. It can, however, help us return with a better question.\n\nHer advice is practical: choose one task, put distractions out of reach, and leave a few minutes between meetings. What changes when we stop filling every silence? The answer may be less about productivity and more about noticing what matters.",
  nl: "Wat meer ruimte om na te denken.\n\nOp een rustige ochtend loopt een onderzoeker naar het station zonder op haar telefoon te kijken. De stad is al wakker, maar ze merkt dingen op die ze normaal mist: een fietsbel, vers brood en zonlicht op de gracht.\n\nIn ons gesprek vertelde ze waarom aandacht ruimte nodig heeft. Een korte pauze lost niet elk ingewikkeld probleem op. Toch kan die helpen om met een betere vraag terug te komen.\n\nHaar advies is praktisch: kies één taak, leg afleiding buiten bereik en houd een paar minuten vrij tussen afspraken. Wat verandert er als we niet elke stilte opvullen? Het antwoord gaat misschien minder over productiviteit en meer over zien wat ertoe doet.",
};
const messages = copy[uiLanguage];
document.documentElement.lang = uiLanguage;
document.querySelectorAll("[data-copy]").forEach((element) => {
  element.textContent = messages[element.dataset.copy];
});
const elements = Object.fromEntries(
  Array.from(document.querySelectorAll("[id]")).map((element) => [
    element.id,
    element,
  ]),
);
document.querySelector(".player").setAttribute("aria-label", messages.playback);
elements.progress.setAttribute("aria-label", messages.completed);
const synth = window.speechSynthesis;
const storageKey = "p2a-voice-demo-v1";
let voices = [];
let passages = [];
let index = 0;
let generation = 0;
let active = false;
let currentUtterance;
let startTimer;
let preferredVoice = "";
const events = [];

function log(event) {
  events.push(`${new Date().toISOString()} ${event}`);
  if (events.length > 100) {
    events.shift();
  }
  elements.log.textContent = events.join("\n");
}
function status(message) {
  elements.status.textContent = message;
}
function save() {
  try {
    localStorage.setItem(
      storageKey,
      JSON.stringify({
        text: elements.text.value,
        language: elements.language.value,
        rate: elements.rate.value,
        voice: preferredVoice,
        index,
      }),
    );
  } catch {
    log(messages.storage);
  }
}
function splitText() {
  const text = elements.text.value.trim();
  const sentences =
    typeof Intl.Segmenter === "function"
      ? Array.from(
          new Intl.Segmenter(elements.language.value, {
            granularity: "sentence",
          }).segment(text),
          (part) => part.segment,
        )
      : text.match(/[^.!?]+(?:[.!?]+|$)/g) || [];
  // Bound long sentences too, so a stopped voice only loses a short passage.
  passages = sentences.flatMap((sentence) => {
    const chunks = [];
    let chunk = "";
    for (const word of sentence.trim().split(/\s+/)) {
      if (chunk && chunk.length + word.length > 160) {
        chunks.push(chunk);
        chunk = "";
      }
      chunk += `${chunk ? " " : ""}${word}`;
    }
    if (chunk) {
      chunks.push(chunk);
    }
    return chunks;
  });
  if (!text) {
    passages = [];
  }
}
function renderProgress() {
  elements.progress.max = Math.max(1, passages.length);
  elements.progress.value = index;
  elements.position.textContent = `${index} / ${passages.length} ${messages.progress}`;
  elements.current.textContent = passages[index] || "";
}
function stop() {
  generation += 1;
  active = false;
  clearTimeout(startTimer);
  synth?.cancel();
  currentUtterance = undefined;
}
function updateVoices() {
  const selected = elements.voice.value || preferredVoice;
  voices =
    synth
      ?.getVoices()
      .filter(
        (voice) =>
          voice.lang.toLowerCase().split(/[-_]/)[0] === elements.language.value,
      ) || [];
  voices.sort(
    (left, right) =>
      Number(right.localService) - Number(left.localService) ||
      left.name.localeCompare(right.name),
  );
  elements.voice.replaceChildren();
  for (const voice of voices) {
    const option = document.createElement("option");
    option.value = `${voice.voiceURI}|${voice.name}|${voice.lang}`;
    option.textContent = `${voice.name} · ${voice.lang} · ${voice.localService ? messages.local : messages.remote}`;
    elements.voice.append(option);
  }
  if (
    Array.from(elements.voice.options).some(
      (option) => option.value === selected,
    )
  ) {
    elements.voice.value = selected;
  }
  preferredVoice = elements.voice.value;
  elements["voice-info"].textContent = voices.length
    ? `${voices.length} · ${elements.language.value}`
    : messages.noVoices;
  for (const name of ["play", "preview"]) {
    elements[name].disabled = !voices.length;
  }
  log(`voices: ${voices.length}; language: ${elements.language.value}`);
}
function speak(preview = false) {
  stop();
  if (!synth || !voices.length) {
    return;
  }
  if (!preview && !passages.length) {
    status(messages.empty);
    return;
  }
  if (!preview && index >= passages.length) {
    index = 0;
  }
  const token = generation;
  const voice = voices[elements.voice.selectedIndex];
  if (!voice) {
    return;
  }
  active = true;
  const requestedAt = performance.now();
  currentUtterance = new SpeechSynthesisUtterance(
    preview ? samples[elements.language.value].split("\n")[0] : passages[index],
  );
  currentUtterance.voice = voice;
  currentUtterance.lang = elements.language.value;
  currentUtterance.rate = Number(elements.rate.value);
  currentUtterance.onstart = () => {
    if (token !== generation) {
      return;
    }
    clearTimeout(startTimer);
    status(messages.playing);
    log(
      `start: ${Math.round(performance.now() - requestedAt)}ms; passage: ${index + 1}; preview: ${preview}`,
    );
  };
  currentUtterance.onend = () => {
    if (token !== generation) {
      return;
    }
    clearTimeout(startTimer);
    active = false;
    log("end");
    if (preview) {
      status(messages.ready);
      return;
    }
    index += 1;
    save();
    renderProgress();
    if (index < passages.length) {
      speak();
    } else {
      status(messages.complete);
    }
  };
  currentUtterance.onerror = (event) => {
    if (token !== generation) {
      return;
    }
    clearTimeout(startTimer);
    active = false;
    status(`${messages.error}: ${event.error}`);
    log(`error: ${event.error}`);
    save();
  };
  currentUtterance.onboundary = (event) => {
    if (token === generation && event.charIndex === 0) {
      log(`boundary: ${event.name}`);
    }
  };
  status(messages.starting);
  renderProgress();
  log(
    `request: ${voice.name}; ${voice.lang}; local: ${voice.localService}; rate: ${elements.rate.value}`,
  );
  startTimer = setTimeout(() => {
    if (token === generation) {
      status(messages.stalled);
      log("start timeout: 8s");
    }
  }, 8000);
  synth.speak(currentUtterance);
}
function resetText() {
  stop();
  index = 0;
  splitText();
  renderProgress();
  save();
  status(messages.ready);
}
elements.language.value = uiLanguage;
elements.text.value = samples[uiLanguage];
let restored = false;
try {
  const stored = JSON.parse(localStorage.getItem(storageKey) || "null");
  if (
    stored &&
    typeof stored.text === "string" &&
    stored.text.length <= 30000 &&
    ["en", "nl"].includes(stored.language)
  ) {
    elements.text.value = stored.text;
    elements.language.value = stored.language;
    if (["0.8", "1", "1.2", "1.5"].includes(stored.rate)) {
      elements.rate.value = stored.rate;
    }
    preferredVoice = typeof stored.voice === "string" ? stored.voice : "";
    splitText();
    index = Number.isInteger(stored.index)
      ? Math.max(0, Math.min(stored.index, passages.length))
      : 0;
    restored = true;
  }
} catch {
  log(messages.storage);
}
splitText();
renderProgress();
status(
  !synth ? messages.unsupported : restored ? messages.saved : messages.ready,
);
elements.device.textContent = navigator.userAgent;
log(`page ready; language: ${navigator.language}; speech: ${Boolean(synth)}`);
updateVoices();
synth?.addEventListener("voiceschanged", updateVoices);
elements.refresh.addEventListener("click", updateVoices);
elements.play.addEventListener("click", () => speak());
elements.preview.addEventListener("click", () => speak(true));
elements.pause.addEventListener("click", () => {
  stop();
  save();
  status(messages.paused);
  log("pause (cancel and retain passage)");
});
elements.restart.addEventListener("click", () => {
  stop();
  index = 0;
  save();
  renderProgress();
  status(messages.ready);
});
for (const [name, offset] of [
  ["previous", -1],
  ["next", 1],
]) {
  elements[name].addEventListener("click", () => {
    const wasActive = active;
    stop();
    index = Math.max(0, Math.min(passages.length, index + offset));
    save();
    renderProgress();
    if (wasActive && index < passages.length) {
      speak();
    } else {
      status(index === passages.length ? messages.complete : messages.ready);
    }
  });
}
for (const name of ["voice", "rate"]) {
  elements[name].addEventListener("change", () => {
    stop();
    preferredVoice = elements.voice.value;
    save();
    status(messages.ready);
  });
}
elements.language.addEventListener("change", () => {
  stop();
  preferredVoice = "";
  elements.voice.replaceChildren();
  updateVoices();
  resetText();
});
elements.text.addEventListener("input", resetText);
elements.sample.addEventListener("click", () => {
  elements.text.value = samples[elements.language.value];
  resetText();
});
elements.long.addEventListener("click", () => {
  elements.text.value = Array(10)
    .fill(samples[elements.language.value])
    .join("\n\n");
  resetText();
});
document.addEventListener("visibilitychange", () => {
  save();
  log(
    `visibility: ${document.visibilityState}; speaking: ${synth?.speaking}; paused: ${synth?.paused}`,
  );
});
window.addEventListener("pagehide", () => {
  save();
  stop();
});
elements.copy.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(
      `${navigator.userAgent}\n${events.join("\n")}`,
    );
    status(messages.copied);
  } catch {
    status(messages.copyFailed);
  }
});
