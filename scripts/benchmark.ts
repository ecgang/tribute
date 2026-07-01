/**
 * Standalone, citable benchmark runner: `npm run benchmark`.
 *
 * Prints the same false-attribution / calibration / cost numbers surfaced live at
 * `GET /api/eval` and in the app's accuracy panel — same evaluate() call, same math,
 * just a plain-text table you can paste into a pitch deck or README without opening
 * the app. See lib/eval.ts for the methodology and README.md's "Credibility / eval
 * harness" section for the literature this follows.
 */
import { evaluate, formatReport } from "../lib/eval";

const result = evaluate();
console.log(formatReport(result));
