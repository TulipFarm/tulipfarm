import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { promisify } from "node:util";
import { brotliCompress, constants, gzip } from "node:zlib";

/*
 * Writes `.br` and `.gz` siblings for every compressible file in the built client, for
 * `@fastify/static`'s `preCompressed` option to serve.
 *
 * Compressing here rather than per request matters because the API is expected to run on small
 * self-hosted boxes (a Raspberry Pi): brotli at maximum quality is far too expensive to do on the
 * fly there, but it is free at build time and the assets are immutable once built.
 */

const gzipAsync = promisify(gzip);
const brotliAsync = promisify(brotliCompress);

/* Text formats only. woff2/png/ico/jpg/webp are already compressed; re-compressing them loses. */
const COMPRESSIBLE = new Set([
  ".css",
  ".html",
  ".js",
  ".json",
  ".map",
  ".mjs",
  ".svg",
  ".txt",
  ".webmanifest",
  ".xml",
]);

/*
 * Below this, an extra file costs more than it saves: the response is a single packet either way and
 * `preCompressed` pays two extra `stat` calls per request to find the variants.
 */
const MIN_BYTES = 1024;

/* Compressing 500+ chunks serially wastes the build machine's cores; zlib runs off the event loop. */
const CONCURRENCY = 8;

async function* walk(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (entry.isFile()) yield path;
  }
}

export interface PrecompressResult {
  files: number;
  rawBytes: number;
  brotliBytes: number;
}

async function compressOne(path: string): Promise<{ raw: number; br: number } | null> {
  const raw = await readFile(path);
  const [br, gz] = await Promise.all([
    brotliAsync(raw, {
      params: {
        [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
        [constants.BROTLI_PARAM_SIZE_HINT]: raw.byteLength,
      },
    }),
    gzipAsync(raw, { level: constants.Z_BEST_COMPRESSION }),
  ]);

  // A variant larger than the original would only ever waste bandwidth; skip both if brotli lost.
  if (br.byteLength >= raw.byteLength) return null;

  await Promise.all([writeFile(`${path}.br`, br), writeFile(`${path}.gz`, gz)]);
  return { raw: raw.byteLength, br: br.byteLength };
}

/** Compresses every eligible file under `dir` in place. Returns totals for the build log. */
export async function precompressDir(dir: string): Promise<PrecompressResult> {
  const targets: string[] = [];
  for await (const path of walk(dir)) {
    if (path.endsWith(".br") || path.endsWith(".gz")) continue;
    if (!COMPRESSIBLE.has(extname(path))) continue;
    if ((await stat(path)).size < MIN_BYTES) continue;
    targets.push(path);
  }

  const result: PrecompressResult = { files: 0, rawBytes: 0, brotliBytes: 0 };
  for (let i = 0; i < targets.length; i += CONCURRENCY) {
    const batch = await Promise.all(targets.slice(i, i + CONCURRENCY).map(compressOne));
    for (const item of batch) {
      if (!item) continue;
      result.files += 1;
      result.rawBytes += item.raw;
      result.brotliBytes += item.br;
    }
  }
  return result;
}
