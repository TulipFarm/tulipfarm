import { createHash } from "node:crypto";
import { type BlobPort, type BlobRef, collectBlobBytes } from "./blob";

/**
 * What every blob implementation must do, as checks a test file runs.
 *
 * One implementation could be described by its own test file. Two cannot: the moment the store is
 * swappable, "identical behaviour" is the actual product claim, and a claim proven by two files
 * that share no assertion is not proven at all. Everything slices 03 onward rely on — content
 * addressing, deduplication, hash verification, range reads, streaming without buffering the whole
 * object — is stated here once and run against each implementation.
 *
 * Checks throw on failure rather than calling an assertion library, so this module stays free of a
 * test framework and can be run from any of them.
 */
export interface BlobConformanceCheck {
  readonly name: string;
  /** `make` yields a fresh, empty store, so no check can see another's objects. */
  readonly run: (make: () => Promise<BlobPort>) => Promise<void>;
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`blob conformance: ${message}`);
}

function equalBytes(actual: Uint8Array, expected: Uint8Array, message: string): void {
  assert(actual.byteLength === expected.byteLength, `${message}: length ${actual.byteLength}`);
  for (let index = 0; index < expected.length; index += 1) {
    assert(actual[index] === expected[index], `${message}: byte ${index}`);
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function pattern(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let index = 0; index < size; index += 1) bytes[index] = (index * 31 + 7) % 251;
  return bytes;
}

async function rejects(operation: () => Promise<unknown>, message: string): Promise<void> {
  try {
    const result = await operation();
    // A rejection may be deferred into the iterable rather than the call, which is still a
    // rejection as far as the contract is concerned.
    if (typeof (result as AsyncIterable<Uint8Array>)?.[Symbol.asyncIterator] === "function") {
      await collectBlobBytes(result as AsyncIterable<Uint8Array>);
    }
  } catch {
    return;
  }
  throw new Error(`blob conformance: ${message}`);
}

const MISSING: BlobRef = {
  key: "0".repeat(64),
  hash: "0".repeat(64),
};

/** One part boundary plus a remainder, so a chunking implementation cannot pass by accident. */
const LARGE_BYTES = 5 * 1024 * 1024 + 4096;

export const BLOB_CONFORMANCE: readonly BlobConformanceCheck[] = [
  {
    name: "round-trips bytes it was given",
    run: async (make) => {
      const blobs = await make();
      const payload = new TextEncoder().encode("the quick brown fox");
      const ref = await blobs.put(payload);
      equalBytes(await collectBlobBytes(await blobs.get(ref)), payload, "round trip");
    },
  },
  {
    name: "addresses an object by the sha256 of its content",
    run: async (make) => {
      const blobs = await make();
      const payload = new TextEncoder().encode("addressed by content");
      const ref = await blobs.put(payload);
      assert(ref.hash === sha256(payload), `hash was ${ref.hash}`);
      assert(ref.key === ref.hash, `key ${ref.key} is not the hash`);
    },
  },
  {
    name: "gives identical content one address, twice",
    run: async (make) => {
      const blobs = await make();
      const payload = new TextEncoder().encode("written twice");
      const first = await blobs.put(payload);
      const second = await blobs.put(payload);
      assert(first.hash === second.hash, "the same bytes landed at two addresses");
      equalBytes(await collectBlobBytes(await blobs.get(second)), payload, "second write");
    },
  },
  {
    name: "stores an empty object and reads it back",
    run: async (make) => {
      const blobs = await make();
      const ref = await blobs.put(new Uint8Array(0));
      assert(ref.hash === sha256(new Uint8Array(0)), "empty object hashed wrong");
      const read = await collectBlobBytes(await blobs.get(ref));
      assert(read.byteLength === 0, `empty read returned ${read.byteLength} bytes`);
      assert((await blobs.head(ref))?.size === 0, "empty object head is not zero");
    },
  },
  {
    name: "accepts a body that is still arriving",
    run: async (make) => {
      const blobs = await make();
      const parts = ["stream ", "in ", "pieces"].map((text) => new TextEncoder().encode(text));
      async function* body(): AsyncIterable<Uint8Array> {
        for (const part of parts) yield part;
      }
      const ref = await blobs.put(body());
      const whole = new TextEncoder().encode("stream in pieces");
      assert(ref.hash === sha256(whole), "streamed body hashed wrong");
      equalBytes(await collectBlobBytes(await blobs.get(ref)), whole, "streamed round trip");
    },
  },
  {
    name: "takes an object larger than one upload part without holding it whole",
    run: async (make) => {
      const blobs = await make();
      const payload = pattern(LARGE_BYTES);
      // Handed over in chunks so an implementation that buffers everything is the only one that
      // ever holds the whole object; one that flushes as it goes never sees more than a part.
      async function* body(): AsyncIterable<Uint8Array> {
        for (let offset = 0; offset < payload.length; offset += 64 * 1024) {
          yield payload.subarray(offset, Math.min(offset + 64 * 1024, payload.length));
        }
      }
      const ref = await blobs.put(body());
      assert(ref.hash === sha256(payload), "large object hashed wrong");
      assert((await blobs.head(ref))?.size === LARGE_BYTES, "large object head size wrong");
      equalBytes(await collectBlobBytes(await blobs.get(ref)), payload, "large round trip");
    },
  },
  {
    name: "yields a read in more than one chunk rather than one whole-object buffer",
    run: async (make) => {
      const blobs = await make();
      const payload = pattern(LARGE_BYTES);
      const ref = await blobs.put(payload);
      let chunks = 0;
      let largest = 0;
      for await (const chunk of await blobs.get(ref)) {
        chunks += 1;
        largest = Math.max(largest, chunk.byteLength);
      }
      assert(chunks > 1, "the whole object arrived as a single chunk");
      assert(largest < LARGE_BYTES, `a single chunk carried ${largest} bytes`);
    },
  },
  {
    name: "reads a range from the middle, inclusive of both bounds",
    run: async (make) => {
      const blobs = await make();
      const payload = new TextEncoder().encode("0123456789");
      const ref = await blobs.put(payload);
      const middle = await collectBlobBytes(await blobs.get(ref, { start: 2, end: 5 }));
      equalBytes(middle, payload.subarray(2, 6), "inclusive range");
    },
  },
  {
    name: "reads an open-ended range to the last byte",
    run: async (make) => {
      const blobs = await make();
      const payload = new TextEncoder().encode("0123456789");
      const ref = await blobs.put(payload);
      const tail = await collectBlobBytes(await blobs.get(ref, { start: 7 }));
      equalBytes(tail, payload.subarray(7), "open-ended range");
    },
  },
  {
    name: "refuses a range that is not a range",
    run: async (make) => {
      const blobs = await make();
      const ref = await blobs.put(new TextEncoder().encode("0123456789"));
      await rejects(() => blobs.get(ref, { start: -1 }), "a negative start was accepted");
      await rejects(() => blobs.get(ref, { start: 4, end: 2 }), "an inverted range was accepted");
      await rejects(() => blobs.get(ref, { start: 1.5 }), "a fractional start was accepted");
    },
  },
  {
    name: "reports size without reading the body",
    run: async (make) => {
      const blobs = await make();
      const payload = new TextEncoder().encode("measure me");
      const ref = await blobs.put(payload);
      assert((await blobs.head(ref))?.size === payload.byteLength, "head size disagrees");
    },
  },
  {
    name: "answers head with null for an object that is not there",
    run: async (make) => {
      const blobs = await make();
      assert((await blobs.head(MISSING)) === null, "head invented an absent object");
    },
  },
  {
    name: "rejects a read of an object that is not there",
    run: async (make) => {
      const blobs = await make();
      await rejects(() => blobs.get(MISSING), "reading an absent object succeeded");
    },
  },
  {
    name: "deletes an object, and deleting it again is not an error",
    run: async (make) => {
      const blobs = await make();
      const ref = await blobs.put(new TextEncoder().encode("delete me"));
      await blobs.delete(ref);
      assert((await blobs.head(ref)) === null, "the object survived its deletion");
      await blobs.delete(ref);
      await blobs.delete(MISSING);
    },
  },
  {
    name: "refuses a ref whose key is not its hash",
    run: async (make) => {
      const blobs = await make();
      const ref = await blobs.put(new TextEncoder().encode("well addressed"));
      const forged = { key: "somewhere-else", hash: ref.hash };
      await rejects(() => blobs.get(forged), "a forged key was read");
      await rejects(() => blobs.head(forged), "a forged key was measured");
    },
  },
  {
    name: "refuses a hash that could not be a sha256",
    run: async (make) => {
      const blobs = await make();
      const ref = { key: "not-a-hash", hash: "not-a-hash" };
      await rejects(() => blobs.get(ref), "a malformed hash was read");
      await rejects(() => blobs.head(ref), "a malformed hash was measured");
    },
  },
];

/**
 * Proves an implementation notices its bytes changed underneath it.
 *
 * Separate from `BLOB_CONFORMANCE` because corrupting a store requires reaching past the port, and
 * how you do that is the one thing an implementation cannot share. Every implementation must still
 * run it — a store that hands back bytes it was not asked for, silently, is the failure this whole
 * content-addressing scheme exists to make impossible.
 */
export const TAMPER_CONFORMANCE: readonly {
  readonly name: string;
  readonly run: (
    make: () => Promise<{ blobs: BlobPort; corrupt: (ref: BlobRef) => Promise<void> }>
  ) => Promise<void>;
}[] = [
  {
    name: "raises rather than returning bytes whose hash no longer matches",
    run: async (make) => {
      const { blobs, corrupt } = await make();
      const ref = await blobs.put(new TextEncoder().encode("honest bytes"));
      await corrupt(ref);
      await rejects(() => blobs.get(ref), "corrupted bytes were returned as if intact");
    },
  },
  {
    name: "does not claim tampering on a ranged read it cannot verify",
    run: async (make) => {
      const { blobs } = await make();
      const payload = new TextEncoder().encode("honest bytes");
      const ref = await blobs.put(payload);
      const slice = await collectBlobBytes(await blobs.get(ref, { start: 0, end: 3 }));
      equalBytes(slice, payload.subarray(0, 4), "unverifiable ranged read");
    },
  },
];
