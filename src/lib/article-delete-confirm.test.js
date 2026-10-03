import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { translate } from "../../public/i18n.js";

const source = ts.createSourceFile(
  "app.js",
  await readFile("public/app.js", "utf8"),
  ts.ScriptTarget.Latest,
  true,
);
const handler = source.statements.find(
  (node) =>
    ts.isFunctionDeclaration(node) &&
    node.name?.text === "deleteCurrentArticle",
);
if (!handler) {
  throw new Error("Missing article deletion handler");
}

function setup(language, confirmed) {
  const button = { disabled: false };
  const status = { textContent: "Existing status" };
  const audio = { pause: vi.fn() };
  const context = {
    currentJob: { id: "test-article" },
    window: { confirm: vi.fn().mockReturnValue(confirmed) },
    t: (key) => translate(language, key),
    $: (selector) =>
      ({
        "#delete-article": button,
        "#article-delete-status": status,
        "#audio": audio,
      })[selector],
    localizedFetch: vi.fn().mockResolvedValue({ ok: true }),
    location: { replace: vi.fn() },
    clearTimeout: vi.fn(),
    readingPositionSaveTimer: undefined,
    pendingReadingSectionIndex: 1,
    hideContinueReading: vi.fn(),
  };
  // Exercise the real handler without booting unrelated page event listeners.
  const remove = runInNewContext(
    `${handler.getText(source)}; deleteCurrentArticle`,
    context,
  );
  return { context, button, status, audio, remove };
}

describe("article deletion confirmation", () => {
  it.each(["nl", "en"])(
    "cancelling in %s leaves the article and UI untouched",
    async (language) => {
      const { context, button, status, audio, remove } = setup(language, false);

      await remove();

      expect(context.window.confirm).toHaveBeenCalledWith(
        translate(language, "article.deleteConfirm"),
      );
      expect(context.localizedFetch).not.toHaveBeenCalled();
      expect(context.location.replace).not.toHaveBeenCalled();
      expect(context.currentJob.id).toBe("test-article");
      expect(button.disabled).toBe(false);
      expect(status.textContent).toBe("Existing status");
      expect(audio.pause).not.toHaveBeenCalled();
    },
  );

  it.each(["nl", "en"])(
    "confirming in %s deletes and returns to the overview",
    async (language) => {
      const { context, remove } = setup(language, true);

      await remove();

      expect(context.window.confirm).toHaveBeenCalledWith(
        translate(language, "article.deleteConfirm"),
      );
      expect(context.localizedFetch).toHaveBeenCalledWith(
        "/api/articles/test-article",
        { method: "DELETE" },
      );
      expect(context.location.replace).toHaveBeenCalledWith("/articles");
      expect(context.currentJob).toBeUndefined();
    },
  );
});
