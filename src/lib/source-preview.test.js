import { describe, expect, it, vi } from "vitest";
import { translate } from "../shared/i18n.js";
import { createSourcePreview } from "../../public/source-preview.ts";

vi.mock("../../public/dom.js", () => ({
  requiredElement: (selector, _constructor, root) =>
    root.querySelector(selector),
}));
vi.stubGlobal("HTMLElement", class {});
vi.mock("../../public/localize.ts", () => ({
  t: (key) => translate("nl", key),
}));

function setup(readyState = 1, desktopMode = false) {
  const media = Object.assign(new EventTarget(), { matches: desktopMode });
  const view = Object.assign(new EventTarget(), {
    innerWidth: 1440,
    innerHeight: 1000,
    matchMedia: () => media,
  });
  const document = Object.assign(new EventTarget(), {
    defaultView: view,
    querySelector: () => ({ getBoundingClientRect: () => ({ right: 1000 }) }),
  });
  const home = {
    append: vi.fn(),
    style: { minHeight: "" },
    getBoundingClientRect: () => ({ height: 54 }),
  };
  const elements = new Map([
    ["[data-preview-player]", { append: vi.fn() }],
    ["[data-preview-metadata]", { textContent: "" }],
    ["[data-preview-transcript]", { textContent: "", hidden: true }],
    ["[data-preview-status]", { textContent: "" }],
    [
      "[data-preview-close]",
      Object.assign(new EventTarget(), { focus: vi.fn() }),
    ],
  ]);
  const dialog = Object.assign(new EventTarget(), {
    open: false,
    classList: { add: vi.fn(), remove: vi.fn(), toggle: vi.fn() },
    style: { width: "", top: "" },
    ownerDocument: document,
    setAttribute: vi.fn(),
    getBoundingClientRect: () => ({ height: 260 }),
    getAnimations: vi.fn().mockReturnValue([]),
    querySelector: (selector) => elements.get(selector),
    show: vi.fn(function () {
      this.open = true;
    }),
    showModal() {
      this.open = true;
    },
    close() {
      this.open = false;
      this.dispatchEvent(new Event("close"));
    },
  });
  const audio = Object.assign(new EventTarget(), {
    parentElement: home,
    readyState,
    currentTime: 0,
    play: vi.fn().mockResolvedValue(undefined),
    pause: vi.fn(),
    load: vi.fn(),
  });
  const paragraph = { classList: { add: vi.fn(), remove: vi.fn() } };
  const opener = {
    focus: vi.fn(),
    setAttribute: vi.fn(),
    closest: () => paragraph,
    getBoundingClientRect: () => ({ top: 400 }),
  };
  return {
    controller: createSourcePreview(dialog, audio),
    dialog,
    audio,
    home,
    elements,
    opener,
    document,
    view,
    media,
    paragraph,
  };
}

describe("source preview", () => {
  it("uses a modal sheet when a wide screen has less than 240px beside the article", () => {
    const preview = setup(1, true);
    preview.view.innerWidth = 1280;
    preview.document.querySelector = () => ({
      getBoundingClientRect: () => ({ right: 1040 }),
    });

    preview.controller.open({ start: 12, label: "0:12" }, preview.opener);

    expect(preview.dialog.show).not.toHaveBeenCalled();
    expect(preview.dialog.setAttribute).toHaveBeenCalledWith(
      "aria-modal",
      "true",
    );
    expect(preview.dialog.style.width).toBe("");
  });

  it("opens a nonmodal desktop pane beside the article and returns focus on Escape", async () => {
    const preview = setup(1, true);

    preview.controller.open({ start: 12, label: "0:12" }, preview.opener);

    expect(preview.dialog.show).toHaveBeenCalledOnce();
    expect(preview.dialog.setAttribute).toHaveBeenCalledWith(
      "aria-modal",
      "false",
    );
    expect(preview.dialog.style.width).toBe("320px");
    expect(preview.dialog.style.top).toBe("400px");
    expect(preview.paragraph.classList.add).toHaveBeenCalledWith(
      "source-preview-active",
    );
    const escape = new Event("keydown", { cancelable: true });
    Object.defineProperty(escape, "key", { value: "Escape" });

    preview.document.dispatchEvent(escape);
    await Promise.resolve();

    expect(escape.defaultPrevented).toBe(true);
    expect(preview.dialog.open).toBe(false);
    expect(preview.paragraph.classList.remove).toHaveBeenCalledWith(
      "source-preview-active",
    );
    expect(preview.opener.focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it("uses a modal sheet on narrow screens and changes mode without stopping the new source", () => {
    const preview = setup();
    preview.controller.open({ start: 12, label: "0:12" }, preview.opener);

    expect(preview.dialog.show).not.toHaveBeenCalled();
    expect(preview.dialog.setAttribute).toHaveBeenCalledWith(
      "aria-modal",
      "true",
    );

    preview.media.matches = true;
    preview.media.dispatchEvent(new Event("change"));

    expect(preview.dialog.open).toBe(true);
    expect(preview.dialog.show).toHaveBeenCalledOnce();
    expect(preview.audio.currentTime).toBe(12);
  });

  it("ignores a queued close event after another citation has opened", () => {
    const preview = setup(1, true);
    preview.controller.open({ start: 12, label: "0:12" }, preview.opener);
    preview.controller.close();
    preview.controller.open({ start: 48, label: "0:48" }, preview.opener);
    const pauseCount = preview.audio.pause.mock.calls.length;

    preview.dialog.dispatchEvent(new Event("close"));

    expect(preview.dialog.open).toBe(true);
    expect(preview.audio.pause).toHaveBeenCalledTimes(pauseCount);
    expect(preview.audio.currentTime).toBe(48);
    expect(preview.opener.setAttribute).toHaveBeenLastCalledWith(
      "aria-expanded",
      "true",
    );
  });

  it("shows the cited text literally and plays from its time without scrolling the article", () => {
    const preview = setup();

    preview.controller.open(
      {
        start: 65,
        label: "1:05",
        speaker: "A",
        text: '<img src=x onerror="alert(1)">',
      },
      preview.opener,
    );

    expect(preview.dialog.open).toBe(true);
    expect(preview.elements.get("[data-preview-transcript]")).toMatchObject({
      hidden: false,
      textContent: '<img src=x onerror="alert(1)">',
    });
    expect(preview.elements.get("[data-preview-metadata]").textContent).toBe(
      "1:05 · A",
    );
    expect(preview.audio.currentTime).toBe(65);
    expect(preview.audio.play).toHaveBeenCalledOnce();
  });

  it("pauses and returns the player and keyboard focus when the reader closes the panel", async () => {
    const preview = setup();
    preview.controller.open({ start: 5, label: "0:05" }, preview.opener);

    preview.elements
      .get("[data-preview-close]")
      .dispatchEvent(new Event("click"));
    await Promise.resolve();

    expect(preview.dialog.open).toBe(false);
    expect(preview.home.append).toHaveBeenCalledWith(preview.audio);
    expect(preview.opener.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(preview.audio.pause).toHaveBeenCalledTimes(3);
  });

  it.each(["click", "cancel"])(
    "pauses immediately on %s and restores focus after the exit animation",
    async (eventName) => {
      const preview = setup(0);
      let finishAnimation;
      const finished = new Promise((resolve) => {
        finishAnimation = resolve;
      });
      preview.dialog.getAnimations.mockReturnValue([{ finished }]);
      preview.controller.open({ start: 120, label: "2:00" }, preview.opener);
      const target =
        eventName === "cancel"
          ? preview.dialog
          : preview.elements.get("[data-preview-close]");

      target.dispatchEvent(new Event(eventName, { cancelable: true }));
      preview.audio.dispatchEvent(new Event("loadedmetadata"));

      expect(preview.dialog.open).toBe(true);
      expect(preview.audio.pause).toHaveBeenCalledTimes(2);
      expect(preview.audio.play).not.toHaveBeenCalled();
      expect(preview.home.append).not.toHaveBeenCalled();
      expect(preview.opener.focus).not.toHaveBeenCalled();

      finishAnimation();
      await vi.waitFor(() => expect(preview.dialog.open).toBe(false));

      expect(preview.home.append).toHaveBeenCalledWith(preview.audio);
      expect(preview.opener.focus).toHaveBeenCalledWith({
        preventScroll: true,
      });
    },
  );

  it("does not let a stale exit close a newly opened citation", async () => {
    const preview = setup();
    let finishAnimation;
    const finished = new Promise((resolve) => {
      finishAnimation = resolve;
    });
    preview.dialog.getAnimations.mockReturnValue([{ finished }]);
    preview.controller.open({ start: 5, label: "0:05" }, preview.opener);
    preview.elements
      .get("[data-preview-close]")
      .dispatchEvent(new Event("click"));

    preview.controller.open({ start: 60, label: "1:00" }, preview.opener);
    finishAnimation();
    await finished;
    await Promise.resolve();
    await Promise.resolve();

    expect(preview.dialog.open).toBe(true);
    expect(preview.audio.currentTime).toBe(60);
    expect(preview.opener.focus).not.toHaveBeenCalled();
  });

  it("does not retain owner transcript text when opening a source without text", () => {
    const preview = setup();
    preview.controller.open(
      { start: 5, label: "0:05", text: "Owner-only text" },
      preview.opener,
    );
    preview.controller.close();

    preview.controller.open({ start: 10, label: "0:10" }, preview.opener);

    expect(preview.elements.get("[data-preview-transcript]")).toMatchObject({
      hidden: true,
      textContent: "",
    });
  });

  it("waits for audio metadata and then seeks to the requested source", () => {
    const preview = setup(0);
    preview.controller.open({ start: 120, label: "2:00" }, preview.opener);
    expect(preview.audio.play).not.toHaveBeenCalled();

    preview.audio.dispatchEvent(new Event("loadedmetadata"));

    expect(preview.audio.currentTime).toBe(120);
    expect(preview.audio.play).toHaveBeenCalledOnce();
  });

  it("does not start delayed playback after Escape or another close action", () => {
    const preview = setup(0);
    preview.controller.open({ start: 120, label: "2:00" }, preview.opener);

    preview.dialog.close();
    preview.audio.dispatchEvent(new Event("loadedmetadata"));

    expect(preview.audio.play).not.toHaveBeenCalled();
    expect(preview.opener.focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it("uses only the latest citation while metadata is still loading", () => {
    const preview = setup(0);
    preview.controller.open({ start: 120, label: "2:00" }, preview.opener);
    preview.controller.open({ start: 240, label: "4:00" }, preview.opener);

    preview.audio.dispatchEvent(new Event("loadedmetadata"));

    expect(preview.audio.currentTime).toBe(240);
    expect(preview.audio.play).toHaveBeenCalledOnce();
  });

  it("explains manual playback when the browser rejects automatic playback", async () => {
    const preview = setup();
    preview.audio.play.mockRejectedValue(new Error("NotAllowedError"));

    preview.controller.open({ start: 5, label: "0:05" }, preview.opener);
    await Promise.resolve();

    expect(preview.elements.get("[data-preview-status]").textContent).toBe(
      translate("nl", "sourcePreview.playManually"),
    );
  });

  it("reports an unavailable audio source", () => {
    const preview = setup();
    preview.controller.open({ start: 5, label: "0:05" }, preview.opener);

    preview.audio.dispatchEvent(new Event("error"));

    expect(preview.elements.get("[data-preview-status]").textContent).toBe(
      translate("nl", "sourcePreview.audioError"),
    );
  });
});
