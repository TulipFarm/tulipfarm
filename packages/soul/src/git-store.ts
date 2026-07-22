import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BOT_GIT_EMAIL, BOT_GIT_NAME } from "@tulipfarm/constants";
import simpleGit, { type SimpleGit } from "simple-git";
import type { SoulFileChange, ValidatedSoulChangeset } from "./changeset";
import {
  buildCommitMessage,
  buildCommitSigningPayload,
  type CommitActor,
  type CommitApproval,
  type CommitSchemaRef,
  type CommitSignature,
  type CommitSigner,
  CommitSigningError,
  type SignedCommitMetadata,
} from "./commit-signing";
import type { Logger } from "./types";

const GIT_TIMEOUT_MS = 30_000;
const SOUL_BRANCH_REF = "refs/heads/main";
const BLOB_MODE = "100644";

export type SoulGitStoreErrorCode =
  | "BASE_MISMATCH"
  | "CONTENT_MISMATCH"
  | "SIGNING_FAILED"
  | "WRITE_FAILED"
  | "REF_UPDATE_FAILED";

/** Deterministic, payload-safe failure from the atomic writer. Carries no file content. */
export class SoulGitStoreError extends Error {
  readonly code: SoulGitStoreErrorCode;

  constructor(code: SoulGitStoreErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SoulGitStoreError";
    this.code = code;
  }
}

export interface SoulCommitRequest {
  /** The validated changeset: authority on paths, operations, base, and schema provenance. */
  readonly changeset: ValidatedSoulChangeset;
  /** The exact content-bearing changes that were validated. Must match `changeset.files`. */
  readonly files: readonly SoulFileChange[];
  readonly actor: CommitActor;
  readonly approval?: CommitApproval;
  /** Human commit subject; defaults to a deterministic summary line. */
  readonly subject?: string;
}

export interface SoulCommitResult {
  readonly commitSha: string;
  readonly treeSha: string;
  readonly parentSha: string | null;
  readonly filesChanged: number;
  readonly signature: CommitSignature;
}

/**
 * Atomic, signed writer for the authored Soul tree — step 12 of the single write gateway.
 *
 * The commit is assembled entirely off to the side: blobs and a tree are built in a private,
 * throwaway index (`GIT_INDEX_FILE`) seeded from the expected base, never touching the working
 * tree or the real index. The tree becomes visible only through a single compare-and-swap ref
 * update against the expected base. Consequences:
 *
 * - A stale base (concurrent write) is rejected up front and again by the CAS ref update.
 * - A signing failure aborts before any ref moves.
 * - An interruption before the ref update leaves HEAD, the index, and the working tree untouched;
 *   the orphaned throwaway objects are unreachable and GC-collected. No partial tree is published.
 */
export class SoulGitStore {
  constructor(
    private readonly soulPath: string,
    private readonly signer: CommitSigner,
    private readonly logger: Logger
  ) {}

  private git(indexFile?: string, extraEnv?: Record<string, string>): SimpleGit {
    const git = simpleGit(this.soulPath, { timeout: { block: GIT_TIMEOUT_MS } });
    if (indexFile === undefined && extraEnv === undefined) return git;
    return git.env({
      ...process.env,
      ...(indexFile !== undefined ? { GIT_INDEX_FILE: indexFile } : {}),
      ...extraEnv,
    });
  }

  /** Current committed tip, or null when the branch is unborn (fresh repo, no commits). */
  private async resolveHead(): Promise<string | null> {
    try {
      return (await this.git().revparse(["HEAD"])).trim();
    } catch {
      return null;
    }
  }

  private assertContentMatches(
    validated: ValidatedSoulChangeset,
    files: readonly SoulFileChange[]
  ): void {
    if (files.length !== validated.files.length) {
      throw new SoulGitStoreError(
        "CONTENT_MISMATCH",
        `Soul git store: content has ${files.length} file(s) but changeset validated ${validated.files.length}`
      );
    }
    validated.files.forEach((validatedFile, index) => {
      const file = files[index];
      if (file.operation !== validatedFile.operation || file.path !== validatedFile.path) {
        throw new SoulGitStoreError(
          "CONTENT_MISMATCH",
          `Soul git store: content at index ${index} does not match the validated changeset`
        );
      }
    });
  }

  private buildMetadata(
    validated: ValidatedSoulChangeset,
    actor: CommitActor,
    approval?: CommitApproval
  ): SignedCommitMetadata {
    const schemas: CommitSchemaRef[] = [];
    for (const file of validated.files) {
      if (file.kind !== undefined && file.apiVersion !== undefined) {
        schemas.push({ kind: file.kind, apiVersion: file.apiVersion });
      }
    }
    return {
      changesetId: validated.id,
      businessId: validated.businessId,
      source: validated.source,
      actor,
      approval,
      schemas,
    };
  }

  /**
   * Build the tree in a private index seeded from `parentSha`, then return the written tree sha.
   * Nothing here is observable to the runtime — the real index and working tree are untouched.
   */
  private async writeTree(
    workDir: string,
    indexFile: string,
    parentSha: string | null,
    files: readonly SoulFileChange[]
  ): Promise<string> {
    const idx = this.git(indexFile);
    if (parentSha !== null) {
      await idx.raw(["read-tree", parentSha]);
    }
    const blobTmp = join(workDir, "blob");
    for (const file of files) {
      if (file.operation === "delete") {
        await idx.raw(["update-index", "--force-remove", file.path]);
        continue;
      }
      writeFileSync(blobTmp, file.content);
      const blobSha = (await idx.raw(["hash-object", "-w", blobTmp])).trim();
      await idx.raw([
        "update-index",
        "--add",
        "--cacheinfo",
        `${BLOB_MODE},${blobSha},${file.path}`,
      ]);
    }
    return (await idx.raw(["write-tree"])).trim();
  }

  /**
   * Atomically publish `request` as a signed commit on `main`. Returns the new commit evidence.
   * Throws `SoulGitStoreError` (deterministic, no file content) on any failure; nothing partial is
   * ever left published.
   */
  async commitChangeset(request: SoulCommitRequest): Promise<SoulCommitResult> {
    const { changeset, files, actor, approval } = request;
    this.assertContentMatches(changeset, files);

    const expected = changeset.expectedBaseCommit === "" ? null : changeset.expectedBaseCommit;
    const parentSha = await this.resolveHead();
    if (parentSha !== expected) {
      throw new SoulGitStoreError(
        "BASE_MISMATCH",
        `Soul git store: expected base ${expected ?? "(none)"} but HEAD is ${parentSha ?? "(none)"}`
      );
    }

    const workDir = mkdtempSync(join(tmpdir(), "soul-changeset-"));
    const indexFile = join(workDir, "index");
    try {
      let treeSha: string;
      try {
        treeSha = await this.writeTree(workDir, indexFile, parentSha, files);
      } catch (error) {
        throw new SoulGitStoreError(
          "WRITE_FAILED",
          `Soul git store: failed to assemble the changeset tree — ${errText(error)}`,
          { cause: error }
        );
      }

      const meta = this.buildMetadata(changeset, actor, approval);
      const payload = buildCommitSigningPayload(treeSha, parentSha, meta);
      let signatureValue: string;
      try {
        signatureValue = this.signer.sign(payload);
      } catch (error) {
        throw new SoulGitStoreError(
          "SIGNING_FAILED",
          `Soul git store: commit signing failed — ${signErrText(error)}`,
          { cause: error }
        );
      }
      const signature: CommitSignature = { keyId: this.signer.keyId, value: signatureValue };

      const subject = request.subject ?? defaultSubject(changeset);
      const message = buildCommitMessage(subject, meta, signature);

      const commitArgs = ["commit-tree", treeSha];
      if (parentSha !== null) commitArgs.push("-p", parentSha);
      commitArgs.push("-m", message);
      const commitSha = (await this.git(indexFile, identityEnv()).raw(commitArgs)).trim();

      const refArgs = ["update-ref", SOUL_BRANCH_REF, commitSha];
      if (parentSha !== null) refArgs.push(parentSha);
      try {
        await this.git().raw(refArgs);
      } catch (error) {
        throw new SoulGitStoreError(
          "REF_UPDATE_FAILED",
          `Soul git store: base moved under the write (concurrent commit) — ${errText(error)}`,
          { cause: error }
        );
      }

      // Materialize the newly published tree into the working directory the loader reads. A crash
      // between the ref update and here leaves HEAD ahead of the working tree — a reconcilable
      // state (`git reset --hard HEAD` on boot), never a partial publish.
      await this.git().reset(["--hard", commitSha]);

      this.logger.info(
        `Soul: committed changeset ${changeset.id} as ${commitSha} (${files.length} file change(s))`
      );
      return {
        commitSha,
        treeSha,
        parentSha,
        filesChanged: files.length,
        signature,
      };
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  }
}

function defaultSubject(changeset: ValidatedSoulChangeset): string {
  const count = changeset.files.length;
  return `soul(${changeset.source}): changeset ${changeset.id} (${count} file${count === 1 ? "" : "s"})`;
}

function identityEnv(): Record<string, string> {
  return {
    GIT_AUTHOR_NAME: BOT_GIT_NAME,
    GIT_AUTHOR_EMAIL: BOT_GIT_EMAIL,
    GIT_COMMITTER_NAME: BOT_GIT_NAME,
    GIT_COMMITTER_EMAIL: BOT_GIT_EMAIL,
  };
}

function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function signErrText(error: unknown): string {
  if (error instanceof CommitSigningError) return error.message;
  return errText(error);
}
