import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { precompressDir } from "./precompress.ts";

const clientDir = resolve(
  process.argv[2] ?? fileURLToPath(new URL("../build/client", import.meta.url))
);
const { files, rawBytes, brotliBytes } = await precompressDir(clientDir);
const kb = (bytes: number) => `${(bytes / 1024).toFixed(1)} kB`;
console.log(
  `[precompress] ${files} files in ${clientDir}: ${kb(rawBytes)} -> ${kb(brotliBytes)} brotli`
);
