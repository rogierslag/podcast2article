import { describe, expect, it } from "vitest";
import { messages, translate } from "../../public/i18n.js";
import {
  DomainError,
  domainErrorStatus,
  type DomainErrorCode,
} from "./errors.js";
import { translateDomainError, translateStoredMessage } from "./i18n.js";

describe("domain errors", () => {
  it.each([
    ["error.jobNotFound", 404],
    ["error.articleDeleteNotReady", 409],
    ["error.articleRetryLimit", 409],
    ["error.accountBudget", 429],
    ["series.errorNotFound", 404],
    ["series.errorDuplicate", 409],
    ["series.errorLimit", 409],
    ["error.creationUnavailable", 503],
  ] satisfies Array<[DomainErrorCode, number]>)(
    "routes %s independently of diagnostic or display wording",
    (code, status) => {
      const error = new DomainError(code);
      error.message = "Entirely different diagnostic text";
      const translations = messages[code];
      if (!translations) {
        throw new Error(`Missing translations: ${code}`);
      }
      const original = translations.en;
      translations.en = "Revised user-facing wording";

      try {
        expect(domainErrorStatus(error, 400)).toBe(status);
        expect(translateDomainError("en", error)).toBe(
          "Revised user-facing wording",
        );
        expect(translateDomainError("nl", error)).toBe(translate("nl", code));
      } finally {
        translations.en = original;
      }
    },
  );

  it.each([
    "Opdracht niet gevonden.",
    "error.jobNotFound",
    "secret token: abc",
  ])(
    "does not treat an ordinary error message as a domain code: %s",
    (message) => {
      const error = new Error(message);

      expect(domainErrorStatus(error, 503)).toBe(503);
      expect(translateDomainError("en", error)).toBe(
        translate("en", "error.generic"),
      );
      expect(translateDomainError("nl", error, "error.processing")).toBe(
        translate("nl", "error.processing"),
      );
    },
  );

  it("localizes structured parameters independently of the diagnostic text", () => {
    const error = new DomainError("error.mediaSize", { size: 125 });
    error.message = "Oversized file";

    for (const language of ["en", "nl"] as const) {
      expect(translateDomainError(language, error)).toBe(
        translate(language, "error.mediaSize", { size: 125 }),
      );
    }
  });

  it("keeps historical messages readable only through the storage compatibility path", () => {
    expect(translateStoredMessage("en", "Opdracht niet gevonden.")).toBe(
      translate("en", "error.jobNotFound"),
    );
    expect(
      translateStoredMessage("en", "Mediabestand is groter dan 125 MB."),
    ).toBe(translate("en", "error.mediaSize", { size: 125 }));
    expect(
      translateStoredMessage("nl", "progress.writing", "error.generic", {
        minutes: 2,
      }),
    ).toBe(translate("nl", "progress.writing", { minutes: 2 }));
  });
});
