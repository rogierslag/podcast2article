/** Stable service error identifiers; diagnostic wording is never a control-flow contract. */
const diagnostics = {
  "error.drivePrivate":
    "Deze Google Meet-opname is niet openbaar. Kies in Drive voor ‘Iedereen met de link’.",
  "error.youtubeVideoRequired":
    "Gebruik een YouTube-link naar één video, niet naar een kanaal, zoekopdracht of afspeellijst.",
  "error.youtubeLiveUnsupported":
    "Live en geplande YouTube-streams worden niet ondersteund. Gebruik de opname nadat de stream is afgelopen.",
  "error.sourceNotMedia":
    "De bron gaf een webpagina terug in plaats van media. Controleer de deel- en downloadrechten.",
  "error.mediaLimit": "Mediabestand overschrijdt de ingestelde limiet.",
  "error.audioSegmentsEmpty":
    "Er konden geen bruikbare audiofragmenten worden gemaakt.",
  "error.audioSegmentTooLarge":
    "Een audiofragment is te groot voor transcriptie.",
  "series.errorNotFound": "series.errorNotFound",
  "series.errorDiscovery": "series.errorDiscovery",
  "series.errorPreview": "series.errorPreview",
  "error.creationUnavailable": "error.creationUnavailable",
  "error.spotifyLinkRequired": "Plak een publieke open.spotify.com-link.",
  "error.spotifyLinkInvalid":
    "Gebruik een Spotify-link naar een aflevering of podcastshow.",
  "error.driveLinkRequired":
    "Plak een publieke Google Drive-link naar de Meet-opname.",
  "error.driveFileRequired":
    "Gebruik een Google Drive-link naar één opnamebestand, niet naar een map of Meet-ruimte.",
  "error.meetRoomLink":
    "Plak de Google Drive-link naar de opname, niet de link naar de Meet-ruimte.",
  "error.sourceUnsupported": "error.sourceUnsupported",
  "error.driveMetadataMissing":
    "Google Drive gaf geen bestandsgegevens terug. Controleer of iedereen met de link toegang heeft.",
  "error.driveMediaUnsupported":
    "De Google Drive-link verwijst niet naar een ondersteund audio- of videobestand.",
  "error.spotifyLinkUnreadable": "Spotify kon deze publieke link niet lezen.",
  "error.podcastDirectoryUnavailable":
    "De openbare podcastindex is tijdelijk niet bereikbaar.",
  "error.spotifyEpisodeRequired":
    "Kies een specifieke Spotify-aflevering; een show bevat meerdere mogelijke afleveringen.",
  "error.spotifyTitleMissing":
    "Spotify gaf geen titel voor deze aflevering terug.",
  "error.spotifySourceUnmatched":
    "Deze publieke Spotify-aflevering kon niet met voldoende zekerheid aan een openbare podcastbron worden gekoppeld. Controleer of de aflevering ook via RSS/Apple Podcasts beschikbaar is.",
  "error.drivePageInvalid": "Google Drive gaf geen geldige opnamepagina terug.",
  "error.transcriptMissing": "OpenAI gaf geen transcripttekst terug.",
  "error.articleMissing": "OpenAI gaf geen artikel terug.",
  "error.usernameInvalid": "Ongeldige gebruikersnaam.",
  "error.jobNotFound": "Opdracht niet gevonden.",
  "error.articleDeleteNotReady":
    "Dit artikel is nog niet klaar om te verwijderen.",
  "error.articleReadNotReady": "Dit artikel is nog niet klaar om te lezen.",
  "error.readingPositionInvalid":
    "Deze leespositie bestaat niet in het artikel.",
  "error.articleShareNotReady": "Dit artikel is nog niet klaar om te delen.",
  "error.sharedNotFound": "Gedeeld artikel niet gevonden.",
  "error.jobAlreadyProcessing": "Deze opdracht wordt al verwerkt.",
  "error.transcriptIncomplete":
    "Deze opdracht heeft geen complete transcriptie om te hergebruiken.",
  "error.articleRetryNotFailed":
    "Alleen mislukte opdrachten kunnen opnieuw worden geprobeerd.",
  "error.articleRetryLimit":
    "Deze opdracht heeft het maximum van twee artikelpogingen bereikt.",
  "series.errorFeed": "series.errorFeed",
  "series.errorEmpty": "series.errorEmpty",
  "series.errorShow": "series.errorShow",
  "series.errorDuplicate": "series.errorDuplicate",
  "series.errorLimit": "series.errorLimit",
  "series.errorNoHistory": "series.errorNoHistory",
  "error.youtubeLinkRequired": "Plak een publieke YouTube-videolink.",
  "error.youtubeTitleMissing": "YouTube gaf geen titel voor deze video terug.",
  "error.youtubePrivate": "Deze YouTube-video is niet openbaar beschikbaar.",
  "error.youtubeLoginRequired":
    "YouTube vereist aanmelding voor deze video; alleen publiek toegankelijke video's worden ondersteund.",
  "error.youtubeScheduled": "Geplande YouTube-streams worden niet ondersteund.",
  "error.youtubeUnavailable": "Deze YouTube-video is niet beschikbaar.",
  "error.youtubeDownloadLimit":
    "De YouTube-audio overschrijdt de ingestelde downloadlimiet.",
  "error.youtubeMetadataMissing": "YouTube gaf geen videogegevens terug.",
  "error.youtubeTimeout": "YouTube reageerde niet binnen de ingestelde tijd.",
  "error.youtubeAudioUnavailable":
    "De YouTube-audio is niet beschikbaar of overschrijdt de ingestelde downloadlimiet.",
  "error.youtubeAudioEmpty": "YouTube gaf een leeg audiobestand terug.",
  "error.youtubeDownloadTimeout": "Het downloaden van YouTube duurde te lang.",
  "error.fathomLinkRequired": "error.fathomLinkRequired",
  "error.fathomShareRequired": "error.fathomShareRequired",
  "error.fathomMetadataMissing": "error.fathomMetadataMissing",
  "error.fathomPrivate": "error.fathomPrivate",
  "error.fathomProcessingFailed": "error.fathomProcessingFailed",
  "error.fathomDownloadLimit": "error.fathomDownloadLimit",
  "error.fathomTimeout": "error.fathomTimeout",
  "error.fathomDownloadEmpty": "error.fathomDownloadEmpty",
  "error.sourceProtocol": "Alleen publieke HTTP(S)-bronnen zijn toegestaan.",
  "error.privateAddress": "Privé-netwerkadressen zijn niet toegestaan.",
  "error.sourceAddress":
    "De bron verwijst niet uitsluitend naar een publiek netwerkadres.",
  "error.sourceRedirectLimit": "Te veel redirects bij het ophalen van de bron.",
  "error.redirectDestinationMissing": "Redirect zonder bestemming ontvangen.",
  "error.mediaSize": "error.mediaSize",
  "error.youtubeUnreadable": "YouTube kon deze publieke video niet lezen.",
  "error.youtubeDownloadFailed":
    "YouTube kon deze publieke video niet downloaden.",
  "error.fathomUnreadable": "error.fathomUnreadable",
  "error.fathomDownloadFailed": "error.fathomDownloadFailed",
  "error.accountBudget": "error.accountBudget",
  "error.duplicateComplete": "error.duplicateComplete",
  "error.duplicateProcessing": "error.duplicateProcessing",
} as const;

export type DomainErrorCode = keyof typeof diagnostics;
export type ErrorValues = Record<string, string | number>;

export class DomainError extends Error {
  constructor(
    public readonly code: DomainErrorCode,
    public readonly values: ErrorValues = {},
  ) {
    super(diagnostics[code]);
    this.name = "DomainError";
  }
}

/** Route fallbacks preserve the existing distinction between mutation and validation failures. */
export function domainErrorStatus(error: unknown, fallback: number): number {
  if (!(error instanceof DomainError)) {
    return fallback;
  }
  switch (error.code) {
    case "error.jobNotFound":
    case "error.sharedNotFound":
    case "series.errorNotFound":
      return 404;
    case "error.accountBudget":
      return 429;
    case "error.creationUnavailable":
      return 503;
    case "error.articleDeleteNotReady":
    case "error.articleReadNotReady":
    case "error.articleShareNotReady":
    case "error.jobAlreadyProcessing":
    case "error.articleRetryNotFailed":
    case "error.articleRetryLimit":
    case "error.transcriptIncomplete":
    case "error.duplicateComplete":
    case "error.duplicateProcessing":
    case "series.errorDuplicate":
    case "series.errorLimit":
      return 409;
    default:
      return fallback;
  }
}
