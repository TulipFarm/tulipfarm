import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeCspHeader } from "./csp-header.ts";

const clientDir = resolve(
  process.argv[2] ?? fileURLToPath(new URL("../build/client", import.meta.url))
);
const header = writeCspHeader(clientDir);
console.log(`[csp-hash] CSP header written to ${clientDir}/.csp-header.txt: ${header}`);
