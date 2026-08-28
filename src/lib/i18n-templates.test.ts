import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { messages } from "../../public/i18n.js";
import { localizeTemplate } from "./i18n.js";

function htmlTranslationKeys(template: string): string[] {
  const placeholders = Array.from(
    template.matchAll(/\{\{([^{}]+)\}\}/g),
    (match) => match[1] ?? "",
  ).filter((key) => key !== "language");
  const attributes = Array.from(
    template.matchAll(/\bdata-i18n(?:-[a-z-]+)?\s*=\s*(["'])(.*?)\1/gs),
    (match) => match[2] ?? "",
  );
  return [...placeholders, ...attributes];
}

function literalKeys(expression: ts.Expression): string[] {
  if (ts.isStringLiteralLike(expression)) {
    return [expression.text];
  }
  if (ts.isParenthesizedExpression(expression)) {
    return literalKeys(expression.expression);
  }
  if (ts.isConditionalExpression(expression)) {
    return [
      ...literalKeys(expression.whenTrue),
      ...literalKeys(expression.whenFalse),
    ];
  }
  throw new Error(`Translation keys must be static: ${expression.getText()}`);
}

function scriptTranslationKeys(script: string, file: string): string[] {
  const source = ts.createSourceFile(
    file,
    script,
    ts.ScriptTarget.Latest,
    true,
  );
  const keys: string[] = [];

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const functionName = node.expression.text;
      const argument = node.arguments[0];
      if (argument && (functionName === "t" || functionName === "countText")) {
        // Only the localization adapter may obtain a key from a data-i18n attribute.
        // Those attribute values are checked independently in every HTML template.
        const attributeLookup =
          path.basename(file) === "localize.js" &&
          (argument.getText() === "element.dataset.i18n" ||
            (ts.isCallExpression(argument) &&
              argument.expression.getText() === "element.getAttribute"));
        if (!attributeLookup) {
          for (const key of literalKeys(argument)) {
            keys.push(
              ...(functionName === "countText"
                ? [`${key}.one`, `${key}.other`]
                : [key]),
            );
          }
        }
      }
    }
    if (ts.isTaggedTemplateExpression(node) && node.tag.getText() === "html") {
      const template = node.template;
      const fragments = ts.isNoSubstitutionTemplateLiteral(template)
        ? [template.text]
        : [
            template.head.text,
            ...template.templateSpans.map((span) => span.literal.text),
          ];
      for (const fragment of fragments) {
        keys.push(...htmlTranslationKeys(fragment));
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(source);
  return keys;
}

function missingKeys(keys: string[]): string[] {
  return [...new Set(keys)].filter((key) => !Object.hasOwn(messages, key));
}

// Discover recursively so new pages and browser template modules are covered automatically.
const publicFiles = (await readdir("public", { recursive: true })).sort();

describe("template translation coverage", () => {
  it.each(publicFiles.filter((file) => file.endsWith(".html")))(
    "defines every placeholder and data-i18n key used in %s",
    async (file) => {
      const template = await readFile(path.join("public", file), "utf8");

      expect(missingKeys(htmlTranslationKeys(template)), file).toEqual([]);
      for (const language of ["nl", "en"] as const) {
        expect(localizeTemplate(template, language)).not.toContain("{{");
      }
    },
  );

  it.each(publicFiles.filter((file) => file.endsWith(".js")))(
    "defines every browser template translation used in %s",
    async (file) => {
      const script = await readFile(path.join("public", file), "utf8");

      expect(missingKeys(scriptTranslationKeys(script, file)), file).toEqual(
        [],
      );
    },
  );

  it("detects missing placeholders and attribute-only keys, excluding the language marker", () => {
    const template = `
      <html lang="{{language}}">
        <h1>{{missing.heading}}</h1>
        <button data-i18n='article.delete' data-i18n-aria-label = "missing.label"></button>
        <input data-i18n-placeholder='missing.placeholder'>
      </html>
    `;

    expect(missingKeys(htmlTranslationKeys(template))).toEqual([
      "missing.heading",
      "missing.label",
      "missing.placeholder",
    ]);
  });

  it("checks both conditional branches, plural variants, and inline HTML attributes", () => {
    const script = [
      'html`<h2>${t(enabled ? "article.contents" : "missing.contents")}</h2>`;',
      "html`<button data-i18n='missing.action'></button>`;",
      'countText("missing.count", count);',
      't(\n"missing.multiline"\n);',
      '// t("comment.notAKey")',
    ].join("\n");

    expect(missingKeys(scriptTranslationKeys(script, "fixture.js"))).toEqual([
      "missing.contents",
      "missing.action",
      "missing.count.one",
      "missing.count.other",
      "missing.multiline",
    ]);
  });

  it("rejects computed template keys instead of silently skipping their validation", () => {
    expect(() =>
      scriptTranslationKeys('t("article." + action)', "fixture.js"),
    ).toThrow("Translation keys must be static");
  });
});
