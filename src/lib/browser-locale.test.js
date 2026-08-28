import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let label;
let namedButton;
let page;
let fetchMock;
let languageButtons;

beforeEach(() => {
  vi.resetModules();
  languageButtons = ["nl", "en"].map((language) => ({
    dataset: { uiLanguage: language },
    setAttribute: vi.fn(),
    addEventListener: vi.fn(),
  }));
  label = { dataset: { i18n: "article.delete" }, textContent: "" };
  namedButton = {
    getAttribute: () => "article.markReadLabel",
    setAttribute: vi.fn(),
  };
  page = {
    cookie: "",
    documentElement: { lang: "" },
    querySelectorAll: (selector) => {
      if (selector === "[data-i18n]") {
        return [label];
      }
      if (selector === "[data-i18n-aria-label]") {
        return [namedButton];
      }
      if (selector === "[data-ui-language]") {
        return languageButtons;
      }
      return [];
    },
  };
  fetchMock = vi.fn().mockResolvedValue({ ok: true });
  vi.stubGlobal("document", page);
  vi.stubGlobal("window", { fetch: fetchMock });
  vi.stubGlobal("location", { protocol: "https:", reload: vi.fn() });
});

afterEach(() => vi.unstubAllGlobals());

describe("browser localization", () => {
  it.each([
    ["nl", "en-US"],
    ["en", "nl-NL"],
  ])(
    "restores the chosen %s language instead of the device language",
    async (chosen, device) => {
      page.cookie = `p2a_ui_language=${chosen}`;
      vi.stubGlobal("navigator", { language: device });

      const locale = await import("../../public/localize.js");
      await locale.localizedFetch("/api/articles");

      expect(locale.language).toBe(chosen);
      expect(page.documentElement.lang).toBe(chosen);
      expect(fetchMock.mock.calls[0][1].headers.get("Accept-Language")).toBe(
        chosen,
      );
      for (const button of languageButtons) {
        expect(button.setAttribute).toHaveBeenCalledWith(
          "aria-pressed",
          String(button.dataset.uiLanguage === chosen),
        );
      }
    },
  );

  it.each([
    ["https:", true],
    ["http:", false],
  ])(
    "persists a language choice and refreshes the current page on %s",
    async (protocol, secure) => {
      vi.stubGlobal("navigator", { language: "nl" });
      location.protocol = protocol;
      await import("../../public/localize.js");
      const handleClick = languageButtons[1].addEventListener.mock.calls[0][1];

      handleClick();

      expect(page.cookie).toBe(
        `p2a_ui_language=en; Path=/; Max-Age=31536000; SameSite=Lax${secure ? "; Secure" : ""}`,
      );
      expect(location.reload).toHaveBeenCalledOnce();
      vi.resetModules();

      const restoredLocale = await import("../../public/localize.js");

      expect(restoredLocale.language).toBe("en");
    },
  );

  it("remembers an explicit choice of the current language without reloading", async () => {
    vi.stubGlobal("navigator", { language: "nl" });
    await import("../../public/localize.js");
    const handleClick = languageButtons[0].addEventListener.mock.calls[0][1];

    handleClick();

    expect(page.cookie).toContain("p2a_ui_language=nl;");
    expect(location.reload).not.toHaveBeenCalled();
  });

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
