/**
 * Indexing a File into Knowledge, in the process that is allowed to parse it.
 *
 * The whole job runs here rather than in the API for one reason: step two reads a stranger's PDF
 * with a PDF parser. That is untrusted-input processing, and it does not belong in the process
 * terminating people's HTTP requests — the same reason `file_create` renders here. Nothing is
 * staged back to the API afterwards, because this process can already reach the pages, chunks and
 * embeddings it needs, and a staging hop would only mean the text crossed a boundary twice.
 */

import type { FileGrantee } from "@tulipfarm/files";
import { extractText, type FileService, isExtractableMediaType } from "@tulipfarm/files";
import type { KnowledgeService } from "@tulipfarm/knowledge";

/** Must match `FILE_INDEX_QUEUE` in `apps/api/src/files/knowledge-bridge.ts`. */
export const FILE_INDEX_QUEUE = "file-index";

/**
 * A request to index one File.
 *
 * Carries ids only. Everything that decides the outcome — the File's owner, its shares, its bytes
 * — is re-read here, so a job that waited in the queue while a share was revoked indexes the
 * readership that exists now rather than the one that existed when somebody clicked.
 */
export interface FileIndexJob {
  readonly fileId: string;
  readonly businessId: string;
  /** The File's owner, and the only Principal permitted to have asked for this. */
  readonly ownerPrincipalId: string;
}

/** Why a File was not indexed. Every one is an ordinary outcome, so none of them throws. */
export type FileIndexOutcome =
  | { readonly kind: "indexed"; readonly pageId: string; readonly truncated: boolean }
  | {
      readonly kind: "skipped";
      readonly reason: "gone" | "no_text" | "unsupported_media_type" | "no_space" | "withdrawn";
    };

export interface FileIndexDeps {
  readonly files: Pick<FileService, "readers" | "content" | "read" | "knowledgeRequested">;
  readonly knowledge: Pick<
    KnowledgeService,
    "ingestSource" | "createSpace" | "findSpaceByName" | "setPageRestriction" | "deletePage"
  >;
}

/** The Space every indexed File lands in. Created on first use; never restricted. */
export const FILE_SPACE_NAME = "Files";

/**
 * The Space a File's Page belongs to, made if it is not there yet.
 *
 * A File has to be a *placed* Page, not a floating one: the lexical arm of retrieval only considers
 * Pages that carry a Space and a path, so an unplaced Page is reachable by vector search alone and
 * is therefore invisible on any deployment with no embedding provider configured — silently, and
 * only for Files.
 *
 * The Space itself is left unrestricted on purpose. Grants intersect down the Space-to-Page chain,
 * so an unrestricted Space imposes no ceiling and each File's own reader grants remain the whole of
 * its authorization. Restricting the Space would instead cap every File in it by one shared list.
 */
async function fileSpaceId(knowledge: FileIndexDeps["knowledge"]): Promise<string | null> {
  const existing = await knowledge.findSpaceByName(FILE_SPACE_NAME);
  if (existing) return existing._id;
  const created = await knowledge.createSpace({
    name: FILE_SPACE_NAME,
    description:
      "Files people added to knowledge. Each one is readable by exactly whoever the file itself is.",
  });
  if (created.ok) return created.space._id;
  // Lost the race with another job: whoever won already made it.
  return created.reason === "name_taken"
    ? ((await knowledge.findSpaceByName(FILE_SPACE_NAME))?._id ?? null)
    : null;
}

async function collect(body: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of body) {
    chunks.push(chunk);
    total += chunk.length;
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return bytes;
}

/** The job body, exported so it can be tested without pg-boss. */
export async function handleFileIndexJob(
  job: FileIndexJob,
  deps: FileIndexDeps
): Promise<FileIndexOutcome> {
  let file: Awaited<ReturnType<FileService["read"]>>;
  try {
    file = await deps.files.read(job.businessId, job.fileId, job.ownerPrincipalId);
  } catch {
    // Destroyed, or no longer this Principal's to index, between enqueue and now. Both are
    // ordinary races and neither is worth a retry: the File this job named is not indexable.
    return { kind: "skipped", reason: "gone" };
  }

  // The owner may have changed their mind while this job sat on the queue. Checked before any
  // work, and again after the write, because only the second check can catch a withdrawal that
  // lands while the bytes are being parsed.
  if (file.knowledgeRequestedAt === null) return { kind: "skipped", reason: "withdrawn" };

  // Asked before the bytes are fetched. An image is refused by `extractText` anyway, and reading a
  // 25 MiB object only to be told so is a cost with no answer attached.
  if (!isExtractableMediaType(file.mediaType)) {
    return { kind: "skipped", reason: "unsupported_media_type" };
  }

  const { body } = await deps.files.content(job.businessId, job.fileId, job.ownerPrincipalId);
  const extracted = await extractText(file.mediaType, await collect(body));
  if (extracted.kind === "refused" || extracted.text.trim().length === 0) {
    return { kind: "skipped", reason: "no_text" };
  }

  // Read after extraction, so the readership written below is the newest one this job can see.
  const readers = await deps.files.readers(job.businessId, job.fileId, job.ownerPrincipalId);

  const spaceId = await fileSpaceId(deps.knowledge);
  if (spaceId === null) return { kind: "skipped", reason: "no_space" };

  const page = await deps.knowledge.ingestSource({
    source: "file",
    sourceId: job.fileId,
    title: file.filename,
    content: extracted.text,
    // Placed rather than floating, so the lexical arm can find it. The path is the File's id
    // because a filename is neither unique nor stable, and two uploads named `notes.pdf` must not
    // collide onto one Page.
    placement: { spaceId, path: `${job.fileId}.md` },
    // Never omitted for a File. Omitted, `ingestSource` leaves the Page Business-wide readable,
    // which would publish a private upload to everybody the moment it was indexed.
    readers,
  });
  if (page === null) return { kind: "skipped", reason: "gone" };

  // Everything above raced with the owner. Between the reads and this write the File may have been
  // destroyed, withdrawn from Knowledge, or had a share revoked — and until the Page existed, none
  // of those could act on it, because they all resolve through the Page. So the same questions are
  // asked once more now that there is something to act on, and the answer is applied here.
  const settled = await settle(deps, job, page._id, readers);
  if (settled !== null) return settled;
  return { kind: "indexed", pageId: page._id, truncated: extracted.truncated };
}

/**
 * Reconciles the Page just written against the File as it stands now.
 *
 * Returns a skip when the Page had to be withdrawn, or `null` when it stands. Removing rather than
 * repairing is the right answer for a destroyed or withdrawn File: there is no correct readership
 * for a document its owner has deleted, and a Page whose File is gone can never be removed by any
 * later request, because every one of them authorizes through the File first.
 */
async function settle(
  deps: FileIndexDeps,
  job: FileIndexJob,
  pageId: string,
  written: readonly FileGrantee[]
): Promise<FileIndexOutcome | null> {
  let current: readonly FileGrantee[];
  try {
    if (!(await deps.files.knowledgeRequested(job.businessId, job.fileId))) {
      await withdraw(deps, pageId);
      return { kind: "skipped", reason: "withdrawn" };
    }
    current = await deps.files.readers(job.businessId, job.fileId, job.ownerPrincipalId);
  } catch {
    await withdraw(deps, pageId);
    return { kind: "skipped", reason: "gone" };
  }
  if (!sameReaders(written, current)) {
    await deps.knowledge.setPageRestriction(pageId, [...current]);
  }
  return null;
}

async function withdraw(deps: FileIndexDeps, pageId: string): Promise<void> {
  // Both halves, always. A soft delete only flags the row; the chunks are what retrieval quotes.
  await deps.knowledge.deletePage(pageId);
}

function sameReaders(a: readonly FileGrantee[], b: readonly FileGrantee[]): boolean {
  if (a.length !== b.length) return false;
  const key = (g: FileGrantee) => `${g.kind}\u0000${g.id}`;
  const left = new Set(a.map(key));
  return b.every((g) => left.has(key(g)));
}
