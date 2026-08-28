import { describe, expect, it } from "vitest";
import {
  countLabel,
  dateLocale,
  messages,
  translate,
  uiLanguage,
} from "../../public/i18n.js";
import {
  localizeJob,
  localizeProcessingJob,
  localizeTemplate,
  requestLanguage,
  translateStoredMessage,
} from "./i18n.js";
import type { Job, ProcessingJobSummary } from "../types.js";

describe("device language", () => {
  it.each([
    ["en-US", "p2a_ui_language=nl", "nl"],
    ["nl-NL", "p2a_ui_language=en", "en"],
    ["en-US", "other=value; p2a_ui_language=nl; another=value", "nl"],
    ["nl-NL", "p2a_ui_language=fr", "nl"],
    ["nl-NL", "p2a_ui_language=", "nl"],
    ["en-US", "p2a_ui_language=nl-BE", "en"],
    ["en-US", "p2a_ui_language=%6El", "en"],
    ["en-US", "other_p2a_ui_language=nl", "en"],
    ["en-US", "p2a_ui_language=<script>", "en"],
  ])(
    "uses only valid explicit preferences with %s and %s",
    (header, cookie, expected) => {
      expect(requestLanguage(header, cookie)).toBe(expected);
    },
  );

  it.each([
    ["nl", "nl"],
    ["nl-NL", "nl"],
    ["nl-BE", "nl"],
    ["NL-be", "nl"],
    ["en-NL", "en"],
    ["de-DE", "en"],
    ["fr", "en"],
    ["", "en"],
    [undefined, "en"],
    ["nld", "en"],
  ])("maps %s to %s", (device, expected) => {
    expect(uiLanguage(device)).toBe(expected);
  });

  it.each([
    ["nl-BE,nl;q=0.9,en;q=0.8", "nl"],
    ["de-DE,nl;q=0.9", "en"],
    ["en-US,nl;q=0.8", "en"],
    ["en;q=0.5,nl;q=1", "nl"],
    ["nl;q=0,en;q=0.8", "en"],
    ["nl;q=invalid,en", "en"],
    ["nl;q=2,en", "en"],
    ["*", "en"],
    [undefined, "en"],
  ])("uses the primary accepted language from %s", (header, expected) => {
    expect(requestLanguage(header)).toBe(expected);
  });
});

describe("translation catalog", () => {
  it("uses semantic identifiers instead of translated copy as keys", () => {
    for (const key of Object.keys(messages)) {
      expect(key).toMatch(/^[a-z][a-zA-Z]*(\.[a-z][a-zA-Z]*)*$/);
      expect(key).not.toBe(messages[key]?.nl);
    }
  });

  it("provides both languages with identical interpolation fields", () => {
    for (const [key, message] of Object.entries(messages)) {
      expect(message.nl, key).toBeTruthy();
      expect(message.en, key).toBeTruthy();
      expect(message.nl.match(/\{\w+\}/g)?.sort() ?? [], key).toEqual(
        message.en.match(/\{\w+\}/g)?.sort() ?? [],
      );
    }
  });

  it("uses natural singular and plural metadata and locale-specific dates", () => {
    expect(countLabel("nl", "sources", 1)).toBe("1 bronfragment");
    expect(countLabel("nl", "sources", 2)).toBe("2 bronfragmenten");
    expect(countLabel("nl", "reading", 1)).toBe("1 minuut leestijd");
    expect(countLabel("en", "sources", 1)).toBe("1 source segment");
    expect(countLabel("en", "sources", 0)).toBe("0 source segments");
    expect(countLabel("en", "reading", 2)).toBe("2-minute read");
    expect(dateLocale("nl-BE")).toBe("nl-NL");
    expect(dateLocale("de")).toBe("en-GB");
  });

  it("escapes translations in server HTML and leaves interpolated values literal", () => {
    expect(localizeTemplate("{{overview.caughtUp}}", "en")).toBe(
      "You’re all caught up.",
    );
    expect(localizeTemplate("{{login.error}}", "nl")).toContain(
      "Probeer het opnieuw.",
    );
    expect(
      translate("en", "article.read", { title: "<script>{count}</script>" }),
    ).toBe("Read <script>{count}</script>");
  });
});

describe("localized server messages", () => {
  it.each([
    ["Artikelretry kon niet starten.", "error.articleRetry"],
    ["Leesstatus kon niet worden opgeslagen.", "error.readState"],
    ["Server herstart; opdracht wordt hervat", "job.resuming"],
    ["Opdracht staat klaar", "job.queued"],
    ["Opname veilig downloaden", "job.downloading"],
    ["Brongebonden blogartikel schrijven", "job.writing"],
  ])(
    "translates the stored message %s after its visible copy changes",
    (stored, key) => {
      for (const language of ["nl", "en"] as const) {
        expect(translateStoredMessage(language, stored)).toBe(
          translate(language, key),
        );
      }
    },
  );

  it("keeps legacy message matching independent of editable Dutch copy", () => {
    const entry = messages["job.complete"];
    if (!entry) {
      throw new Error("Missing job.complete translation");
    }
    const originalCopy = entry.nl;

    try {
      entry.nl = "Alles is klaar.";

      expect(
        translateStoredMessage("nl", "Artikel en transcript zijn klaar"),
      ).toBe("Alles is klaar.");
      expect(
        translateStoredMessage("en", "Artikel en transcript zijn klaar"),
      ).toBe("The article and transcript are ready");
    } finally {
      entry.nl = originalCopy;
    }
  });

  it("translates existing stored progress messages without changing persistence", () => {
    const job = {
      id: "11111111-1111-4111-8111-111111111111",
      sourceUrl: "https://example.com/recording",
      stage: "transcribing",
      language: "fr",
      articleLength: "standard",
      progress: 50,
      createdAt: "2026-08-27T00:00:00Z",
      updatedAt: "2026-08-27T00:00:00Z",
      message: "Transcriptie 2/4",
      article: {
        title: "Titre français",
        dek: "Introduction",
        readingTimeMinutes: 1,
        styleNote: "Clair",
        sections: [],
        takeaways: [],
      },
    } satisfies Job;

    const result = localizeJob(job, "en");

    expect(result.message).toBe("Transcribing 2/4");
    expect(result.language).toBe("fr");
    expect(result.article).toBe(job.article);
    expect(job.message).toBe("Transcriptie 2/4");
  });

  it("translates processing fallbacks and errors, never untrusted raw errors", () => {
    const summary = {
      id: "example",
      title: "Nieuwe opname",
      sourceName: "Bron wordt opgehaald",
      stage: "resolving",
      progress: 8,
      message: "Unknown legacy status",
      createdAt: "2026-08-27T00:00:00Z",
    } satisfies ProcessingJobSummary;

    expect(localizeProcessingJob(summary, "en")).toMatchObject({
      title: "New recording",
      sourceName: "Retrieving source",
      message: "Checking source",
    });
    expect(translateStoredMessage("en", "Opdracht niet gevonden")).toBe(
      "Request not found.",
    );
    expect(
      translateStoredMessage("nl", "Error: /private/server/file token=secret"),
    ).toBe(translate("nl", "error.generic"));
    expect(translateStoredMessage("en", "Transcriptie starten (1 deel)")).toBe(
      "Starting transcription (1 part)",
    );
    expect(translateStoredMessage("en", "Transcriptie starten (2 delen)")).toBe(
      "Starting transcription (2 parts)",
    );
    expect(
      translateStoredMessage("en", "Artikel wordt geschreven · 3 min. wachten"),
    ).toBe("Writing article · waiting 3 min");
  });
});
