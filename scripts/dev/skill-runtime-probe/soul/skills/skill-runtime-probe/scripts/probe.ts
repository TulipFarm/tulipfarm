// Sandbox contract: arguments arrive as an Artifact, the result must be written to
// $TULIP_OUTPUT_DIR/result.json, and the container has no network. The runtime only strips
// TypeScript types, so this file must stay erasable syntax.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface ProbeArguments {
  readonly message?: string;
}

const inputDir = process.env.TULIP_INPUT_DIR ?? "";
const outputDir = process.env.TULIP_OUTPUT_DIR ?? "";

const args = JSON.parse(readFileSync(join(inputDir, "0-input.json"), "utf8")) as ProbeArguments;
const message = args.message ?? "no message";

process.stderr.write(`probe.ts received: ${message}\n`);

writeFileSync(
  join(outputDir, "result.json"),
  JSON.stringify({
    ok: true,
    runtime: "typescript",
    interpreter: `Node ${process.version}`,
    echoed: message,
  })
);
