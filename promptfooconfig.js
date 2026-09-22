import { existsSync } from "node:fs";
import { cases } from "./evals/cases.mjs";

if (existsSync(".env.lab")) process.loadEnvFile(".env.lab");

export default {
  description: "Post classification: production OpenRouter vs Jev",
  prompts: ["{{fullText}}"],
  providers: [
    { id: "file://./evals/classifier-provider.ts", label: "production", config: { classifier: "production" } },
    { id: "file://./evals/classifier-provider.ts", label: "jev", config: { classifier: "jev" } },
  ],
  tests: cases.map(([name, fullText, expected, quotedText, isReply]) => ({
    description: name,
    vars: {
      authorUsername: "sama",
      createdAt: "2026-09-21T10:00:00.000Z",
      fullText,
      isReply: Boolean(isReply),
      quotedText: quotedText || "",
      quotedCreatedAt: "",
      quotedUrl: "",
      url: "https://x.com/sama/status/1",
    },
    assert: [{ type: "equals", value: expected }],
    metadata: { expected },
  })),
  evaluateOptions: { maxConcurrency: 2 },
};
