import type { ArtifactKind } from "@tulipfarm/schema";
import type {
  SoulReadResult,
  SoulWriteRequest,
  SoulWriteResult,
  SoulWriter,
  SoulWriteTarget,
} from "./writer";
import { SoulWriteError } from "./writer";

/**
 * An in-memory stand-in for the Soul write gateway.
 *
 * Route and Tool tests care about *what a handler asked the gateway to do* — the artifact it
 * addressed, the ops it batched, the subject it committed under. They do not care that git wrote
 * bytes, and standing up a real repository per test costs about a second each. Before the gateway
 * existed these tests mocked `node:fs` and asserted on file paths, which coupled every test to the
 * on-disk layout the gateway now owns.
 *
 * The tree it models is flat and content-addressed by artifact, which is enough to answer the two
 * questions handlers ask before writing: does this exist, and what is in it.
 */
export interface SoulWriterDouble {
  readonly writer: SoulWriter;
  /** Every accepted request, in order. */
  readonly applied: SoulWriteRequest[];
  /** Seed a definition so `exists`/`read` answer true for it. */
  put(kind: ArtifactKind, slug: string | undefined, content: string): void;
  /** Seed a companion so `readCompanion` answers for it. */
  putCompanion(kind: ArtifactKind, slug: string, name: string, content: string): void;
  /** Make the next `apply` reject, to exercise a handler's failure branch. */
  failNextWith(error: Error): void;
}

const keyFor = (kind: ArtifactKind, slug?: string, companion?: string): string =>
  `${kind}/${slug ?? ""}${companion === undefined ? "" : `/${companion}`}`;

export function makeSoulWriterDouble(baseCommit = "0".repeat(40)): SoulWriterDouble {
  const tree = new Map<string, string>();
  const revisions = new Map<string, string>();
  const applied: SoulWriteRequest[] = [];
  let nextFailure: Error | undefined;

  const read = (kind: ArtifactKind, slug?: string): string | null =>
    tree.get(keyFor(kind, slug)) ?? null;

  const writer = {
    exists: (kind: ArtifactKind, slug?: string) => tree.has(keyFor(kind, slug)),
    read,
    readWithBase: async (kind: ArtifactKind, slug?: string): Promise<SoulReadResult> => ({
      content: read(kind, slug),
      baseCommit,
    }),
    revision: async (target: SoulWriteTarget) =>
      revisions.get(keyFor(target.kind, target.slug, target.companion)) ?? baseCommit,
    readCompanion: (kind: ArtifactKind, slug: string, name: string) =>
      tree.get(keyFor(kind, slug, name)) ?? null,
    readCompanionWithBase: async (
      kind: ArtifactKind,
      slug: string,
      name: string
    ): Promise<SoulReadResult> => ({
      content: tree.get(keyFor(kind, slug, name)) ?? null,
      baseCommit,
    }),
    apply: async (request: SoulWriteRequest): Promise<SoulWriteResult> => {
      if (nextFailure !== undefined) {
        const failure = nextFailure;
        nextFailure = undefined;
        throw failure;
      }
      for (const precondition of request.expectedRevisions ?? []) {
        const current =
          revisions.get(
            keyFor(
              precondition.target.kind,
              precondition.target.slug,
              precondition.target.companion
            )
          ) ?? baseCommit;
        if (current !== precondition.revision) {
          throw new SoulWriteError("CONFLICT", "Soul write: artifact changed since it was read");
        }
      }
      const commitSha = (applied.length + 1).toString(16).padStart(40, "0");
      const paths: string[] = [];
      for (const change of request.changes) {
        if (change.op === "deleteArtifact") {
          const prefix = keyFor(change.kind, change.slug);
          for (const key of [...tree.keys()]) {
            if (key === prefix || key.startsWith(`${prefix}/`)) {
              tree.delete(key);
              revisions.delete(key);
            }
          }
          paths.push(prefix);
          continue;
        }
        const key = keyFor(change.target.kind, change.target.slug, change.target.companion);
        if (change.op === "put") {
          tree.set(key, change.content);
          revisions.set(key, commitSha);
        } else {
          tree.delete(key);
          revisions.delete(key);
        }
        paths.push(key);
      }
      applied.push(request);
      return {
        commitSha,
        filesChanged: paths.length,
        paths,
        pushed: true,
        published: true,
      };
    },
  };

  return {
    writer: writer as unknown as SoulWriter,
    applied,
    put: (kind, slug, content) => {
      const key = keyFor(kind, slug);
      tree.set(key, content);
      revisions.set(key, baseCommit);
    },
    putCompanion: (kind, slug, name, content) => {
      const key = keyFor(kind, slug, name);
      tree.set(key, content);
      revisions.set(key, baseCommit);
    },
    failNextWith: (error) => {
      nextFailure = error;
    },
  };
}
