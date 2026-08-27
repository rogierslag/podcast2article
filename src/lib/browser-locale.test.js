import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let label;
let namedButton;
let page;
let fetchMock;

beforeEach(() => {
  vi.resetModules();
  label = { dataset: { i18n: "article.delete" }, textContent: "" };
  namedButton = {
    getAttribute: () => "article.markReadLabel",
    setAttribute: vi.fn(),
  };
  page = {
    documentElement: { lang: "" },
    querySelectorAll: (selector) => {
      if (selector === "[data-i18n]") {
        return [label];
      }
      if (selector === "[data-i18n-aria-label]") {
        return [namedButton];
      }
      return [];
    },
  };
  fetchMock = vi.fn().mockResolvedValue({ ok: true });
  vi.stubGlobal("document", page);
  vi.stubGlobal("window", { fetch: fetchMock });
});

afterEach(() => vi.unstubAllGlobals());

describe("browser localization", () => {
  it.each([
    ["nl-BE", ["nl-BE", "en"], "nl", "Dit artikel verwijderen"],
    ["en-US", ["en-US", "nl"], "en", "Delete this article"],
    ["de-DE", ["de-DE", "nl"], "en", "Delete this article"],
    ["", ["nl"], "nl", "Dit artikel verwijderen"],
    [undefined, [], "en", "Delete this article"],
  ])(
    "uses primary device language %s for visible and accessible copy",
    async (primary, languages, expected, text) => {
      vi.stubGlobal("navigator", { language: primary, languages });

      const locale = await import("../../public/localize.js");

      expect(locale.language).toBe(expected);
      expect(page.documentElement.lang).toBe(expected);
      expect(label.textContent).toBe(text);
      expect(namedButton.setAttribute).toHaveBeenCalledWith(
        "aria-label",
        expected === "nl"
          ? "Markeer dit artikel als gelezen"
          : "Mark this article as read",
      );
    },
  );

  it("passes the UI language to APIs while preserving request data and headers", async () => {
    vi.stubGlobal("navigator", { language: "nl-BE" });
    const locale = await import("../../public/localize.js");

    await locale.localizedFetch("/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: '{"language":"fr"}',
    });

    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/jobs");
    expect(options.headers.get("Accept-Language")).toBe("nl");
    expect(options.headers.get("Content-Type")).toBe("application/json");
    expect(options.body).toBe('{"language":"fr"}');
  });

  it("shows translated errors without leaking raw browser exception text", async () => {
    vi.stubGlobal("navigator", { language: "nl" });
    const locale = await import("../../public/localize.js");

    expect(locale.errorText(new TypeError("Failed to fetch"))).toBe(
      locale.t("error.network"),
    );
    expect(locale.errorText(new SyntaxError("Unexpected token"))).toBe(
      locale.t("error.generic"),
    );
    expect(
      locale.errorText(
        new locale.LocalizedError("Artikel kon niet worden verwijderd."),
      ),
    ).toBe("Artikel kon niet worden verwijderd.");
  });
});
