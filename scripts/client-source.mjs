import { readFileSync } from "node:fs";
import ts from "typescript";

// Isolated VM tests supply their own browser and network boundaries.
export function browserSource(filename) {
  return ts
    .transpileModule(readFileSync(filename, "utf8"), {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
      },
    })
    .outputText.replace(/^import\b[\s\S]*?;\s*/gm, "")
    .replace(/^export \{\};?\s*/gm, "");
}
