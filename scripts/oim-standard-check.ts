import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseOimManifest as sourceParseManifest } from "../packages/schema/src/oim.ts";
import { parseOimManifest as portableParseManifest } from "../standards/oim/dist/oim-runtime.mjs";
import {
  generateOimStandardRuntime,
  oimStandardSchemas,
  serializeOimStandardSchema,
} from "./oim-standard-lib.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const STANDARD = join(ROOT, "standards/oim");
const mismatches: string[] = [];
const checkDirectory = join(STANDARD, ".oim-standard-check");

await rm(checkDirectory, { recursive: true, force: true });
await mkdir(checkDirectory, { recursive: true });
try {
  const generatedRuntime = join(checkDirectory, "oim-runtime.mjs");
  await generateOimStandardRuntime(ROOT, generatedRuntime);
  if (
    (await readFile(generatedRuntime, "utf8")) !==
    (await readFile(join(STANDARD, "dist/oim-runtime.mjs"), "utf8"))
  ) {
    mismatches.push("dist/oim-runtime.mjs is stale");
  }
} finally {
  await rm(checkDirectory, { recursive: true, force: true });
}

for (const [relativePath, schema] of oimStandardSchemas()) {
  const expected = serializeOimStandardSchema(schema);
  const actual = await readFile(join(STANDARD, "schemas", relativePath), "utf8");
  if (actual !== expected) mismatches.push(`schemas/${relativePath} is stale`);
}

const vectorIndex = JSON.parse(
  await readFile(join(STANDARD, "vectors/manifest/index.json"), "utf8")
) as { vectors: Array<{ file: string; valid: boolean }> };

for (const vector of vectorIndex.vectors) {
  const source = await readFile(join(STANDARD, "vectors/manifest", vector.file), "utf8");
  const sourceResult = validate(sourceParseManifest, source);
  const portableResult = validate(portableParseManifest, source);
  if (JSON.stringify(sourceResult) !== JSON.stringify(portableResult)) {
    mismatches.push(`vectors/manifest/${vector.file} differs from the authoritative source`);
  }
  if (sourceResult.valid !== vector.valid) {
    mismatches.push(`vectors/manifest/${vector.file} has the wrong declared result`);
  }
}

if (mismatches.length > 0) {
  throw new Error(mismatches.join("\n"));
}

function validate(
  parse: (source: string) => unknown,
  source: string
): { valid: boolean; issues: string[] } {
  try {
    parse(source);
    return { valid: true, issues: [] };
  } catch (error) {
    return {
      valid: false,
      issues: [error instanceof Error ? error.message : String(error)],
    };
  }
}
