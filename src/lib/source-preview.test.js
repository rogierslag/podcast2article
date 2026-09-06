import { describe, expect, it, vi } from "vitest";
import { translate } from "../../public/i18n.js";
import { createSourcePreview } from "../../public/source-preview.js";

vi.mock("../../public/localize.js", () => ({
  t: (key) => translate("nl", key),
}));

function setup(readyState = 1) {
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
    classList: { add: vi.fn(), remove: vi.fn() },
    getAnimations: vi.fn().mockReturnValue([]),
    querySelector: (selector) => elements.get(selector),
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
  const opener = { focus: vi.fn() };
  return {
    controller: createSourcePreview(dialog, audio),
    dialog,
    audio,
    home,
    elements,
    opener,
  };
}

describe("source preview", () => {
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
