import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "vitest";
import type { BlobPort, BlobRef } from "./blob";
import { BLOB_CONFORMANCE, TAMPER_CONFORMANCE } from "./blob-conformance";
import { FileSystemBlobPort } from "./filesystem-blob";
import { InMemoryS3 } from "./in-memory-s3";
import { S3BlobPort } from "./s3-blob";

/**
 * The claim this file exists to prove: a deployment can change its storage substrate and every
 * behaviour slices 03 onward were built on is unchanged. One set of expectations, no
 * per-implementation exceptions.
 *
 * The shared fake runs the same suite from `@tulipfarm/testkit`, not from here: production code
 * must never be able to reach the testkit, and an allowlisted edge in this direction would make
 * that reachable.
 */

async function temporaryRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "blob-conformance-"));
}

const IMPLEMENTATIONS: readonly {
  readonly name: string;
  readonly make: () => Promise<BlobPort>;
  readonly tamperable: () => Promise<{ blobs: BlobPort; corrupt: (ref: BlobRef) => Promise<void> }>;
}[] = [
  {
    name: "FileSystemBlobPort",
    make: async () => new FileSystemBlobPort(await temporaryRoot()),
    tamperable: async () => {
      const root = await temporaryRoot();
      return {
        blobs: new FileSystemBlobPort(root),
        corrupt: async (ref) => {
          const path = join(root, ref.hash.slice(0, 2), ref.hash);
          const held = await readFile(path);
          await writeFile(path, Buffer.concat([held, Buffer.from("!")]));
        },
      };
    },
  },
  {
    name: "S3BlobPort",
    make: async () => new S3BlobPort(new InMemoryS3()),
    tamperable: async () => {
      const s3 = new InMemoryS3();
      return {
        blobs: new S3BlobPort(s3),
        corrupt: async (ref) => {
          s3.corrupt(`${ref.hash.slice(0, 2)}/${ref.hash}`, new Uint8Array([1, 2, 3]));
        },
      };
    },
  },
];

describe.each(IMPLEMENTATIONS)("$name", ({ make, tamperable }) => {
  for (const check of BLOB_CONFORMANCE) {
    it(check.name, async () => {
      await check.run(make);
    });
  }

  for (const check of TAMPER_CONFORMANCE) {
    it(check.name, async () => {
      await check.run(tamperable);
    });
  }
});
