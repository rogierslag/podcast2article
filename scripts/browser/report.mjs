import { readFile, appendFile } from "node:fs/promises";

const report = JSON.parse(
  await readFile("test-results/browser-results.json", "utf8"),
);
function cases(suite) {
  return [
    ...(suite.specs ?? []).flatMap((spec) =>
      spec.tests.map((test) => ({ title: spec.title, ...test })),
    ),
    ...(suite.suites ?? []).flatMap(cases),
  ];
}
const tests = cases(report);
const known = tests.filter((test) => test.expectedStatus === "failed");
const passing = tests.filter(
  (test) => test.expectedStatus === "passed" && test.status === "expected",
);
const unexpected = tests.filter(
  (test) => test.status === "unexpected" || test.status === "flaky",
);
const summary = [
  "## Browser regressions",
  "",
  `${passing.length} passing regressions; ${known.length} executions of known unresolved bugs; ${unexpected.length} unexpected results.`,
  "",
  ...known.map(
    (test) =>
      `- **Known unresolved bug (${test.projectName}):** ${test.title.replace(/^known bug: /, "")}`,
  ),
  "",
  "Known bugs are executed with an expected-failure annotation. A green run does not mean they are fixed. See the browser-regressions-* artifacts and the README testing limitations.",
  "",
].join("\n");
console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY) {
  await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
}
