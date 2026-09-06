/**
 * The extraction half of File-into-Knowledge.
 *
 * Two things here are worth a test and nothing else is. First, every refusal must be an ordinary
 * outcome: a File someone destroyed while the job queued, or a photograph with no text in it, is
 * not a failure and must not be retried forever. Second, the readers passed to `ingestSource` are
 * the only thing standing between a private upload and a Business-wide readable Page, so their
 * absence must be impossible rather than merely unlikely.
 */

import { describe, expect, it } from "vitest";
import { FILE_SPACE_NAME, type FileIndexDeps, handleFileIndexJob } from "./file-index";

const JOB = {
  fileId: "file-1",
  versionId: "version-1",
  businessId: "biz",
  ownerPrincipalId: "owner",
};

function bytes(text: string): AsyncIterable<Uint8Array> {
  return (async function* () {
    yield new TextEncoder().encode(text);
  })();
}

function deps(
  overrides: {
    mediaType?: string;
    text?: string;
    readers?: { kind: "user" | "role"; id: string }[];
    missing?: boolean;
    requested?: boolean;
    stillRequested?: boolean;
    readersAfter?: { kind: "user" | "role"; id: string }[];
  } = {}
): {
  deps: FileIndexDeps;
  ingested: Record<string, unknown>[];
  restricted: { kind: string; id: string }[][];
  deleted: string[];
} {
  const ingested: Record<string, unknown>[] = [];
  const restricted: { kind: string; id: string }[][] = [];
  const deleted: string[] = [];
  const calls = { readers: 0 };
  return {
    ingested,
    restricted,
    deleted,
    deps: {
      files: {
        read: async () => {
          if (overrides.missing) throw new Error("not_found");
          return {
            id: JOB.fileId,
            filename: "handbook.txt",
            mediaType: overrides.mediaType ?? "text/plain",
            currentVersionId: JOB.versionId,
            knowledgeRequestedAt: overrides.requested === false ? null : new Date(),
          } as never;
        },
        knowledgeRequested: async () => overrides.stillRequested !== false,
        content: async () => ({ body: bytes(overrides.text ?? "refunds take 14 days") }) as never,
        readers: async () => {
          const first = overrides.readers ?? [{ kind: "user" as const, id: "owner" }];
          if (calls.readers++ === 0 || overrides.readersAfter === undefined) return first;
          return overrides.readersAfter;
        },
      },
      knowledge: {
        setPageRestriction: async (_pageId: string, subjects: unknown) => {
          restricted.push(subjects as { kind: string; id: string }[]);
          return "ok" as const;
        },
        deletePage: async (pageId: string) => {
          deleted.push(pageId);
          return true;
        },
        findSpaceByName: async () => ({ _id: "space-1" }) as never,
        createSpace: async () => ({ ok: true, space: { _id: "space-1" } }) as never,
        ingestSource: async (input) => {
          ingested.push(input as unknown as Record<string, unknown>);
          return { _id: "page-1" } as never;
        },
      },
    },
  };
}

describe("indexing a File", () => {
  it("indexes the extracted text under the File's own readers", async () => {
    const { deps: d, ingested } = deps({ readers: [{ kind: "user", id: "owner" }] });
    const outcome = await handleFileIndexJob(JOB, d);
    expect(outcome).toEqual({ kind: "indexed", pageId: "page-1", truncated: false });
    expect(ingested[0]).toMatchObject({
      source: "file",
      sourceId: JOB.fileId,
      readers: [{ kind: "user", id: "owner" }],
      // Placed, not floating: an unplaced Page is invisible to the lexical arm of retrieval, so a
      // deployment with no embedding provider would index the File and never find it again.
      placement: { spaceId: "space-1", path: `${JOB.fileId}.md` },
    });
  });

  it("passes every grantee through, so a shared File stays readable by whoever holds it", async () => {
    const readers = [
      { kind: "user" as const, id: "owner" },
      { kind: "role" as const, id: "support" },
    ];
    const { deps: d, ingested } = deps({ readers });
    await handleFileIndexJob(JOB, d);
    expect(ingested[0]?.readers).toEqual(readers);
  });

  it("skips a File that is gone, without throwing it back at the queue", async () => {
    const { deps: d, ingested } = deps({ missing: true });
    expect(await handleFileIndexJob(JOB, d)).toEqual({ kind: "skipped", reason: "gone" });
    expect(ingested).toHaveLength(0);
  });

  it("refuses an image before its bytes are ever fetched", async () => {
    const { ingested, deps: d } = deps({ mediaType: "image/png" });
    const guarded: FileIndexDeps = {
      ...d,
      files: {
        ...d.files,
        content: async () => {
          throw new Error("the bytes must not be read for an unextractable type");
        },
      },
    };
    expect(await handleFileIndexJob(JOB, guarded)).toEqual({
      kind: "skipped",
      reason: "unsupported_media_type",
    });
    expect(ingested).toHaveLength(0);
  });

  it("indexes nothing when a supported File turns out to hold no text", async () => {
    const { deps: d, ingested, deleted } = deps({ text: "   \n  " });
    expect(await handleFileIndexJob(JOB, d, "page-old")).toEqual({
      kind: "skipped",
      reason: "no_text",
    });
    expect(ingested).toHaveLength(0);
    expect(deleted).toEqual(["page-old"]);
  });
});

describe("where an indexed File lands", () => {
  it("makes the Files space the first time one is indexed", async () => {
    const made: string[] = [];
    const { deps: d } = deps();
    const fresh: FileIndexDeps = {
      ...d,
      knowledge: {
        ...d.knowledge,
        findSpaceByName: async () => null,
        createSpace: async (input) => {
          made.push(input.name);
          return { ok: true, space: { _id: "space-new" } } as never;
        },
      },
    };
    expect(await handleFileIndexJob(JOB, fresh)).toMatchObject({ kind: "indexed" });
    expect(made).toEqual([FILE_SPACE_NAME]);
  });

  it("uses the space another job just made rather than failing the race", async () => {
    const { deps: d, ingested } = deps();
    let looked = 0;
    const racing: FileIndexDeps = {
      ...d,
      knowledge: {
        ...d.knowledge,
        findSpaceByName: async () => (looked++ === 0 ? null : ({ _id: "space-won" } as never)),
        createSpace: async () => ({ ok: false, reason: "name_taken" }) as never,
      },
    };
    expect(await handleFileIndexJob(JOB, racing)).toMatchObject({ kind: "indexed" });
    expect(ingested[0]).toMatchObject({ placement: { spaceId: "space-won" } });
  });

  it("does nothing for a File whose owner withdrew it before the job ran", async () => {
    const { deps: d, ingested } = deps({ requested: false });
    expect(await handleFileIndexJob(JOB, d)).toEqual({ kind: "skipped", reason: "withdrawn" });
    expect(ingested).toEqual([]);
  });

  it("withdraws the page it just wrote when the request was cancelled mid-job", async () => {
    // The whole point of the second check. Until the Page existed there was nothing for the
    // owner's `DELETE .../knowledge` to remove, so it succeeded against nothing — and without this
    // the job would then publish a File its owner had already taken back.
    const { deps: d, deleted } = deps({ stillRequested: false });
    expect(await handleFileIndexJob(JOB, d)).toEqual({ kind: "skipped", reason: "withdrawn" });
    expect(deleted).toEqual(["page-1"]);
  });

  it("withdraws the page it just wrote when the File was destroyed mid-job", async () => {
    // The worst of the races: a Page whose File is gone can never be removed by a later request,
    // because every one of them authorizes through the File first. It has to be cleaned up here.
    const { deps: d, deleted } = deps();
    let seen = 0;
    const racing: FileIndexDeps = {
      ...d,
      files: {
        ...d.files,
        readers: async () => {
          if (seen++ > 0) throw new Error("not_found");
          return [{ kind: "user" as const, id: "owner" }];
        },
      },
    };
    expect(await handleFileIndexJob(JOB, racing)).toEqual({ kind: "skipped", reason: "gone" });
    expect(deleted).toEqual(["page-1"]);
  });

  it("withdraws the page when the File disappears between the write and the recheck", async () => {
    // The post-ingest read is an authorization read, so a File destroyed at exactly this moment
    // makes it throw. Left to propagate, the job fails with the Page already written, and every
    // retry stops at the read above it — so the destroyed File stays retrievable forever.
    const { deps: d, deleted } = deps();
    let reads = 0;
    const racing: FileIndexDeps = {
      ...d,
      files: {
        ...d.files,
        read: async (...args: Parameters<FileIndexDeps["files"]["read"]>) => {
          if (reads++ > 0) throw new Error("not_found");
          return d.files.read(...args);
        },
      },
    };
    expect(await handleFileIndexJob(JOB, racing)).toEqual({ kind: "skipped", reason: "gone" });
    expect(deleted).toEqual(["page-1"]);
  });

  it("withdraws the page when the File vanishes during the pass that re-reads a new version", async () => {
    // A version landing mid-job sends this job round again, carrying the Page it already wrote. If
    // that second pass finds the File gone and simply returns, the Page it was handed is never
    // removed and the first version's text stays searchable for a File nobody can open.
    const { deps: d, deleted } = deps();
    let reads = 0;
    const racing: FileIndexDeps = {
      ...d,
      files: {
        ...d.files,
        read: async (...args: Parameters<FileIndexDeps["files"]["read"]>) => {
          reads += 1;
          // 1: the opening read. 2: the post-ingest recheck, which reports a newer version and so
          // sends the job round again. 3: the recursion's opening read, by which point it is gone.
          if (reads >= 3) throw new Error("not_found");
          const file = await d.files.read(...args);
          return reads === 2 ? ({ ...file, currentVersionId: "version-2" } as never) : file;
        },
      },
    };

    expect(await handleFileIndexJob(JOB, racing)).toEqual({ kind: "skipped", reason: "gone" });

    expect(deleted).toEqual(["page-1"]);
  });

  it("re-applies a share revoked while the bytes were being parsed", async () => {
    // The revoke could not reach the Page: it did not exist yet, so the API's own sync bailed. The
    // readership written by `ingestSource` is therefore stale by exactly one revoke.
    const { deps: d, restricted } = deps({
      readers: [
        { kind: "user", id: "owner" },
        { kind: "user", id: "bob" },
      ],
      readersAfter: [{ kind: "user", id: "owner" }],
    });
    expect(await handleFileIndexJob(JOB, d)).toMatchObject({ kind: "indexed" });
    expect(restricted).toEqual([[{ kind: "user", id: "owner" }]]);
  });

  it("does not rewrite the readership when nothing changed", async () => {
    const { deps: d, restricted } = deps();
    expect(await handleFileIndexJob(JOB, d)).toMatchObject({ kind: "indexed" });
    expect(restricted).toEqual([]);
  });
});
