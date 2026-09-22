import { build } from "esbuild";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { cases } from "../evals/cases.mjs";

// Run explicitly: rtk proxy node scripts/eval-classifier.mjs
// These held-out cases are never included in the model's instructions.
process.chdir(fileURLToPath(new URL("../", import.meta.url)));
if (existsSync(".env.lab")) process.loadEnvFile(".env.lab");
if (!process.env.OPENROUTER_API_KEY) {
  throw new Error("Set OPENROUTER_API_KEY in .env.lab or the environment to evaluate the real model.");
}

const bundle = await build({ entryPoints: ["src/classifier.ts"], bundle: true, platform: "node", format: "esm", write: false });
const { classifyTweet, isOpenRouterFallbackRationale, DEFAULT_MODEL } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
);

const model = process.env.OPENROUTER_MODEL || DEFAULT_MODEL;
console.log(`Evaluating ${cases.length} cases with ${model}; no Telegram messages are sent.`);
let passed = 0;
let unavailable = 0;
let attempted = 0;
for (const [name, fullText, expected, quotedText] of cases) {
  attempted += 1;
  try {
    const result = await classifyTweet(
      { OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY, OPENROUTER_MODEL: model },
      {
        id: "1", url: "https://x.com/sama/status/1", authorUsername: "sama",
        createdAt: new Date().toISOString(), fullText, quotedText: quotedText || null,
        isReply: name === "missing reply context", isRetweet: false,
      },
      (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(20000) }),
    );
    if (isOpenRouterFallbackRationale(result.rationale)) {
      unavailable += 1;
      console.log(`UNAVAILABLE ${name}: ${result.rationale}`);
      // Stop on provider failure instead of spending requests on fallback results.
      break;
    }
    const matches = result.verdict === expected;
    if (matches) passed += 1;
    console.log(`${matches ? "PASS" : "FAIL"} ${name}: expected=${expected} actual=${result.verdict} confidence=${result.confidence} | ${result.rationale}`);
  } catch (error) {
    unavailable += 1;
    console.error(`UNAVAILABLE ${name}: ${error instanceof Error ? error.message : String(error)}`);
    break;
  }
}
console.log(`${passed}/${attempted} attempted cases passed; ${unavailable} unavailable; ${cases.length - attempted} not run. This is a small semantic smoke test, not a general accuracy estimate.`);
if (passed !== cases.length) process.exitCode = 1;
