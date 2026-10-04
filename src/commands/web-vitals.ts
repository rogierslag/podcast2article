import path from "node:path";
import {
  readWebVitals,
  summarizeWebVitals,
} from "../services/web-vitals-summary.js";

const { reports, invalidLines } = await readWebVitals(
  path.resolve(process.argv[2] ?? "data/web-vitals"),
);
console.log(
  JSON.stringify(
    { invalidLines, groups: summarizeWebVitals(reports) },
    null,
    2,
  ),
);
