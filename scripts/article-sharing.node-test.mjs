import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { translate } from "../public/i18n.js";

const app = readFileSync("public/app.js", "utf8");
const handler = app.slice(
  app.indexOf("async function shareArticle()"),
  app.indexOf('resultView.addEventListener("click", sourceClick)'),
);
function setup({
  mobile = true,
  language = "nl",
  share,
  ok = true,
  clipboardError,
} = {}) {
  const buttons = [{ disabled: false }, { disabled: false }];
  const copied = [];
  const statuses = [];
  const url = `https://example.com/s/${"a".repeat(43)}`;
  const context = {
    currentJob: {
      id: "test-article",
      article: { title: "Ruimte voor aandacht" },
    },
    document: { querySelectorAll: () => buttons },
    matchMedia: () => ({ matches: mobile }),
    navigator: { share },
    localizedFetch: async () => ({
      ok,
      json: async () => ({ url, error: ok ? undefined : "Share failed" }),
    }),
    LocalizedError: Error,
    errorText: (error) => error.message,
    t: (key, values) => translate(language, key, values),
    setArticleActionStatus: (...status) => statuses.push(status),
    copyToClipboard: async (value) => {
      if (clipboardError) {
        throw new Error(clipboardError);
      }
      copied.push(value);
    },
  };
  runInNewContext(handler + "; this.shareArticle = shareArticle;", context);
  return { ...context, buttons, copied, statuses, url };
}
for (const language of ["nl", "en"]) {
  test(`native share includes the capability URL exactly once (${language}, PR 7)`, async () => {
    let payload;
    const state = setup({
      language,
      share: async (value) => {
        payload = value;
      },
    });

    await state.shareArticle();

    assert.equal(payload.url, state.url);
    assert.equal(payload.text.includes(state.url), false);
    assert.ok(payload.text.includes(state.currentJob.article.title));
    assert.equal(payload.title, state.currentJob.article.title);
    assert.deepEqual(state.copied, []);
    assert.ok(state.buttons.every((button) => !button.disabled));
  });
}
for (const mobile of [false, true]) {
  test(`clipboard fallback copies the link and announces success (mobile=${mobile}, PR 4)`, async () => {
    const state = setup({ mobile });

    await state.shareArticle();

    assert.deepEqual(state.copied, [state.url]);
    assert.deepEqual(state.statuses.at(-1), [
      translate("nl", "share.copied"),
      true,
    ]);
    assert.ok(state.buttons.every((button) => !button.disabled));
  });
}
test("cancelling native sharing stays silent and does not copy (PR 4)", async () => {
  const state = setup({
    share: async () => {
      throw Object.assign(new Error("cancelled"), { name: "AbortError" });
    },
  });

  await state.shareArticle();

  assert.deepEqual(state.copied, []);
  assert.deepEqual(state.statuses, [[""]]);
  assert.ok(state.buttons.every((button) => !button.disabled));
});
test("failed native sharing falls back to clipboard (PR 4)", async () => {
  const state = setup({
    share: async () => {
      throw new Error("unavailable");
    },
  });

  await state.shareArticle();

  assert.deepEqual(state.copied, [state.url]);
});
for (const options of [{ ok: false }, { clipboardError: "Copy failed" }]) {
  test(`failed sharing remains retryable (${JSON.stringify(options)})`, async () => {
    const state = setup(options);

    await state.shareArticle();

    assert.deepEqual(state.copied, []);
    assert.match(state.statuses.at(-1)[0], /failed/);
    assert.ok(state.buttons.every((button) => !button.disabled));
  });
}

function statusSetup() {
  const statuses = Array.from({ length: 2 }, () => ({
    textContent: "",
    classList: { toggle() {} },
  }));
  const timers = new Map();
  let nextTimer = 0;
  const context = {
    $: (selector) => statuses[selector === "#article-action-status" ? 0 : 1],
    setTimeout: (callback, delay) => {
      timers.set(++nextTimer, { callback, delay });
      return nextTimer;
    },
    clearTimeout: (id) => timers.delete(id),
  };
  runInNewContext(
    app.slice(
      app.indexOf("let articleActionStatusTimer;"),
      app.indexOf("async function exportToPdf()"),
    ) + "; this.setStatus = setArticleActionStatus;",
    context,
  );
  return { statuses, timers, setStatus: context.setStatus };
}

test("success feedback clears both article statuses after four seconds", () => {
  const state = statusSetup();

  state.setStatus("Copied", true);

  assert.ok(state.statuses.every((status) => status.textContent === "Copied"));
  const timer = [...state.timers.values()][0];
  assert.equal(timer.delay, 4000);
  timer.callback();
  assert.ok(state.statuses.every((status) => status.textContent === ""));
});

test("new feedback replaces the timer and errors remain readable", () => {
  const state = statusSetup();

  state.setStatus("Copied", true);
  state.setStatus("Downloaded", true);

  assert.equal(state.timers.size, 1);
  state.setStatus("Failed");
  assert.equal(state.timers.size, 0);
  assert.ok(state.statuses.every((status) => status.textContent === "Failed"));

  state.setStatus("Copied", true);
  state.setStatus("");
  assert.equal(state.timers.size, 0);
});
