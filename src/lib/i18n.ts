import type { Job, ProcessingJobSummary } from "../types.js";
import {
  translate,
  countLabel,
  messages,
  uiLanguage,
  preferredUiLanguage,
  type UiLanguage,
} from "../../public/i18n.js";

/** Only the primary preference decides: a secondary Dutch preference is not a Dutch device. */
export function requestLanguage(
  header?: string,
  cookieHeader?: string,
): UiLanguage {
  const preference = preferredUiLanguage(cookieHeader);
  if (preference) {
    return preference;
  }
  const preferences = (header ?? "")
    .split(",")
    .map((entry, index) => {
      const [tag, ...parameters] = entry.trim().split(";");
      const weight = parameters.find((parameter) =>
        parameter.trim().startsWith("q="),
      );
      const quality = weight ? Number(weight.trim().slice(2)) : 1;
      return { tag, quality, index };
    })
    .filter(
      ({ tag, quality }) =>
        tag && Number.isFinite(quality) && quality > 0 && quality <= 1,
    );
  preferences.sort(
    (left, right) => right.quality - left.quality || left.index - right.index,
  );
  return uiLanguage(preferences[0]?.tag);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

export function localizeTemplate(
  template: string,
  language: UiLanguage,
): string {
  return template.replace(/\{\{([^{}]+)\}\}/g, (_placeholder, key: string) =>
    escapeHtml(key === "language" ? language : translate(language, key)),
  );
}

const stageLabels: Record<Job["stage"], string> = {
  queued: "stage.queued",
  resolving: "stage.resolving",
  downloading: "stage.downloading",
  transcribing: "stage.transcribing",
  writing: "stage.writing",
  complete: "job.complete",
  failed: "error.processing",
};

export function localizeJob(job: Job, language: UiLanguage): Job {
  return {
    ...job,
    message: translateStoredMessage(
      language,
      job.message,
      stageLabels[job.stage],
    ),
    ...(job.error
      ? {
          error: translateStoredMessage(
            language,
            job.error,
            "error.processing",
          ),
        }
      : {}),
  };
}

export function localizeProcessingJob(
  job: ProcessingJobSummary,
  language: UiLanguage,
): ProcessingJobSummary {
  return {
    ...job,
    title:
      job.title === "Nieuwe opname"
        ? translate(language, "job.defaultTitle")
        : job.title,
    sourceName:
      job.sourceName === "Bron wordt opgehaald"
        ? translate(language, "job.retrievingSource")
        : job.sourceName,
    message: translateStoredMessage(
      language,
      job.message,
      stageLabels[job.stage],
    ),
  };
}

// Compatibility with Dutch messages already persisted by the processing services.
// These are source data, not translation keys; keep them stable when editing copy.
const legacyMessageKeys = new Map([
  ["Geef een geldige leespositie op.", "error.readingPositionInvalid"],
  [
    "Deze leespositie bestaat niet in het artikel.",
    "error.readingPositionInvalid",
  ],
  ["Leespositie kon niet worden opgeslagen.", "error.readingPositionSave"],
  ["Je sessie is verlopen. Log opnieuw in.", "error.sessionExpired"],
  ["De opdracht kon niet starten.", "error.jobStart"],
  ["Opdracht niet gevonden.", "error.jobNotFound"],
  ["Verwerking mislukt.", "error.processingFailed"],
  ["PDF-export is mislukt.", "error.pdfExport"],
  ["Kopiëren is niet gelukt.", "error.copy"],
  ["Permalink kon niet worden aangemaakt.", "error.shareCreate"],
  ["Leesstatus kon niet worden opgeslagen.", "error.readState"],
  ["Artikel kon niet worden verwijderd.", "error.articleDelete"],
  [
    "Artikel kon niet worden verwijderd. Probeer het opnieuw.",
    "error.articleDeleteRetry",
  ],
  ["Het overzicht kon niet worden opgehaald.", "error.overviewLoad"],
  ["Gedeeld artikel niet gevonden.", "error.sharedNotFound"],
  ["Audio niet gevonden.", "error.audioNotFound"],
  ["Audio is nog niet beschikbaar", "error.audioNotReady"],
  [
    "Te veel mislukte pogingen. Probeer het over een kwartier opnieuw.",
    "error.loginRateLimit",
  ],
  ["Log opnieuw in om verder te gaan.", "error.loginRequired"],
  [
    "Plak een publieke Spotify-, YouTube- of Google Drive-link.",
    "error.sourceLinkRequired",
  ],
  ["Ongeldige bronlink", "error.sourceLinkInvalid"],
  ["Geef een geldige leesstatus op.", "error.readStateInvalid"],
  [
    "Dit artikel is nog niet klaar om te verwijderen.",
    "error.articleDeleteNotReady",
  ],
  ["Ongeldige invoer", "error.invalidInput"],
  ["OPENAI_API_KEY ontbreekt in de CLI-omgeving.", "error.creationUnavailable"],
  ["Dit artikel is nog niet klaar voor PDF-export.", "error.pdfNotReady"],
  ["PDF-export is op dit moment niet beschikbaar.", "error.pdfUnavailable"],
  ["Artikelretry kon niet starten.", "error.articleRetry"],
  ["Ongeldige gebruikersnaam.", "error.usernameInvalid"],
  ["Onbekende podcast", "source.unknownPodcast"],
  ["Nieuwe opname", "job.defaultTitle"],
  ["Bron wordt opgehaald", "job.retrievingSource"],
  ["Dit artikel is nog niet klaar om te lezen.", "error.articleReadNotReady"],
  ["Dit artikel is nog niet klaar om te delen.", "error.articleShareNotReady"],
  ["Deze opdracht wordt al verwerkt.", "error.jobAlreadyProcessing"],
  [
    "Deze opdracht heeft geen complete transcriptie om te hergebruiken.",
    "error.transcriptIncomplete",
  ],
  ["Opdracht staat klaar", "job.queued"],
  ["Artikel opnieuw genereren met bestaand transcript", "job.regenerating"],
  ["Server herstart; opdracht wordt hervat", "job.resuming"],
  ["Artikel en transcript zijn klaar", "job.complete"],
  ["Server afgesloten; artikelretry kan worden hervat", "job.retryPaused"],
  ["Openbare opnamebron controleren", "job.checkingSource"],
  ["Opname gevonden", "job.sourceFound"],
  ["Opname veilig downloaden", "job.downloading"],
  ["Audio uit opname halen", "job.extractingAudio"],
  ["Audio opdelen voor transcriptie", "job.splittingAudio"],
  ["Transcript compleet", "job.transcriptComplete"],
  ["Server afgesloten; opdracht wordt na herstart hervat", "job.paused"],
  ["Brongebonden blogartikel schrijven", "job.writing"],
  ["Plak een publieke open.spotify.com-link.", "error.spotifyLinkRequired"],
  [
    "Gebruik een Spotify-link naar een aflevering of podcastshow.",
    "error.spotifyLinkInvalid",
  ],
  [
    "Plak een publieke Google Drive-link naar de Meet-opname.",
    "error.driveLinkRequired",
  ],
  [
    "Gebruik een Google Drive-link naar één opnamebestand, niet naar een map of Meet-ruimte.",
    "error.driveFileRequired",
  ],
  [
    "Plak de Google Drive-link naar de opname, niet de link naar de Meet-ruimte.",
    "error.meetRoomLink",
  ],
  [
    "Alleen publieke Spotify-afleveringen, YouTube-video's en Google Drive-opnames worden ondersteund.",
    "error.sourceUnsupported",
  ],
  [
    "Google Drive gaf geen bestandsgegevens terug. Controleer of iedereen met de link toegang heeft.",
    "error.driveMetadataMissing",
  ],
  [
    "De Google Drive-link verwijst niet naar een ondersteund audio- of videobestand.",
    "error.driveMediaUnsupported",
  ],
  ["Spotify kon deze publieke link niet lezen.", "error.spotifyLinkUnreadable"],
  [
    "De openbare podcastindex is tijdelijk niet bereikbaar.",
    "error.podcastDirectoryUnavailable",
  ],
  [
    "Kies een specifieke Spotify-aflevering; een show bevat meerdere mogelijke afleveringen.",
    "error.spotifyEpisodeRequired",
  ],
  [
    "Spotify gaf geen titel voor deze aflevering terug.",
    "error.spotifyTitleMissing",
  ],
  [
    "Deze publieke Spotify-aflevering kon niet met voldoende zekerheid aan een openbare podcastbron worden gekoppeld. Controleer of de aflevering ook via RSS/Apple Podcasts beschikbaar is.",
    "error.spotifySourceUnmatched",
  ],
  [
    "Deze Google Meet-opname is niet openbaar. Kies in Drive voor ‘Iedereen met de link’.",
    "error.drivePrivate",
  ],
  [
    "Google Drive gaf geen geldige opnamepagina terug.",
    "error.drivePageInvalid",
  ],
  [
    "De bron gaf een webpagina terug in plaats van media. Controleer de deel- en downloadrechten.",
    "error.sourceNotMedia",
  ],
  ["Mediabestand overschrijdt de ingestelde limiet.", "error.mediaLimit"],
  [
    "Er konden geen bruikbare audiofragmenten worden gemaakt.",
    "error.audioSegmentsEmpty",
  ],
  [
    "Een audiofragment is te groot voor transcriptie.",
    "error.audioSegmentTooLarge",
  ],
  ["OpenAI gaf geen transcripttekst terug.", "error.transcriptMissing"],
  ["OpenAI gaf geen artikel terug.", "error.articleMissing"],
  ["Alleen publieke HTTP(S)-bronnen zijn toegestaan.", "error.sourceProtocol"],
  ["Privé-netwerkadressen zijn niet toegestaan.", "error.privateAddress"],
  [
    "De bron verwijst niet uitsluitend naar een publiek netwerkadres.",
    "error.sourceAddress",
  ],
  [
    "Te veel redirects bij het ophalen van de bron.",
    "error.sourceRedirectLimit",
  ],
  ["Redirect zonder bestemming ontvangen.", "error.redirectDestinationMissing"],
  ["Plak een publieke YouTube-videolink.", "error.youtubeLinkRequired"],
  [
    "YouTube gaf geen titel voor deze video terug.",
    "error.youtubeTitleMissing",
  ],
  ["Deze YouTube-video is niet openbaar beschikbaar.", "error.youtubePrivate"],
  [
    "YouTube vereist aanmelding voor deze video; alleen publiek toegankelijke video's worden ondersteund.",
    "error.youtubeLoginRequired",
  ],
  [
    "Geplande YouTube-streams worden niet ondersteund.",
    "error.youtubeScheduled",
  ],
  ["Deze YouTube-video is niet beschikbaar.", "error.youtubeUnavailable"],
  [
    "De YouTube-audio overschrijdt de ingestelde downloadlimiet.",
    "error.youtubeDownloadLimit",
  ],
  ["YouTube kon deze publieke video niet lezen.", "error.youtubeUnreadable"],
  [
    "YouTube kon deze publieke video niet downloaden.",
    "error.youtubeDownloadFailed",
  ],
  ["YouTube gaf geen videogegevens terug.", "error.youtubeMetadataMissing"],
  ["YouTube reageerde niet binnen de ingestelde tijd.", "error.youtubeTimeout"],
  [
    "De YouTube-audio is niet beschikbaar of overschrijdt de ingestelde downloadlimiet.",
    "error.youtubeAudioUnavailable",
  ],
  ["YouTube gaf een leeg audiobestand terug.", "error.youtubeAudioEmpty"],
  [
    "Het downloaden van YouTube duurde te lang.",
    "error.youtubeDownloadTimeout",
  ],
]);

export function translateStoredMessage(
  language: UiLanguage,
  message: unknown,
  fallback = "error.generic",
): string {
  const key = typeof message === "string" ? message : "";
  if (Object.hasOwn(messages, key)) {
    return translate(language, key);
  }
  const legacyKey =
    legacyMessageKeys.get(key) ?? legacyMessageKeys.get(`${key}.`);
  if (legacyKey) {
    return translate(language, legacyKey);
  }
  let match = /^Transcriptie (\d+)\/(\d+)$/.exec(key);
  if (match?.[1] && match[2]) {
    return translate(language, "progress.transcription", {
      done: match[1],
      total: match[2],
    });
  }
  match = /^Transcriptie starten \((\d+) (?:deel|delen)\)$/.exec(key);
  if (match?.[1]) {
    return translate(language, "progress.start", {
      parts: countLabel(language, "parts", Number(match[1])),
    });
  }
  match = /^(.+): wacht (\d+) min\. op OpenAI$/.exec(key);
  if (match?.[1] && match[2]) {
    return translate(language, "progress.wait", {
      chunk: match[1],
      minutes: match[2],
    });
  }
  match = /^Artikel wordt geschreven · (\d+) min\. wachten$/.exec(key);
  if (match?.[1]) {
    return translate(language, "progress.writing", { minutes: match[1] });
  }
  match = /^Mediabestand is groter dan (\d+(?:\.\d+)?) MB\.$/.exec(key);
  if (match?.[1]) {
    return translate(language, "error.mediaSize", { size: match[1] });
  }
  return translate(language, fallback);
}
