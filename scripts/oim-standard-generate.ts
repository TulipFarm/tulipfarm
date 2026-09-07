import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  generateOimStandardRuntime,
  oimStandardSchemas,
  serializeOimStandardSchema,
} from "./oim-standard-lib.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const STANDARD = join(ROOT, "standards/oim");

await rm(join(STANDARD, "schemas"), { recursive: true, force: true });
for (const [relativePath, schema] of oimStandardSchemas()) {
  const output = join(STANDARD, "schemas", relativePath);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, serializeOimStandardSchema(schema));
}

await mkdir(join(STANDARD, "dist"), { recursive: true });
await generateOimStandardRuntime(ROOT, join(STANDARD, "dist/oim-runtime.mjs"));
