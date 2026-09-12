import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateOimStandardRuntime, generateOimStandardSchemas } from "./oim-standard-lib.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const STANDARD = join(ROOT, "standards/oim");

await generateOimStandardSchemas(ROOT, join(STANDARD, "schemas"));

await mkdir(join(STANDARD, "dist"), { recursive: true });
await generateOimStandardRuntime(ROOT, join(STANDARD, "dist/oim-runtime.mjs"));
