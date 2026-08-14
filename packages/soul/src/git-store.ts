import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve, sep } from "node:path";
import { BOT_GIT_EMAIL, BOT_GIT_NAME } from "@tulipfarm/constants";
import simpleGit, { type SimpleGit } from "simple-git";
import {
  isUnbornBase,
  SOUL_UNBORN_BASE,
  type SoulFileChange,
  type ValidatedSoulChangeset,
} from "./changeset";
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
import { hermeticGitEnv } from "./git-env";
import { parseSoulFile } from "./parse";
import type { Logger } from "./types";

const GIT_TIMEOUT_MS = 30_000;
const BLOB_MODE = "100644";
const ZERO_OID = "0".repeat(40);

export type SoulGitStoreErrorCode =
  | "ACTOR_MISMATCH"
  | "BASE_MISMATCH"
  | "CONTENT_MISMATCH"
  | "SIGNING_FAILED"
  | "WRITE_FAILED"
  | "REF_UPDATE_FAILED"
  | "POST_COMMIT_CLEANUP_FAILED"
  /** HEAD is detached or not a branch. A repository-state fault, never a losable race. */
  | "BRANCH_UNRESOLVED";

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

/** Atomic signed writer: build in a private index, sign, then CAS-update the branch ref. */
export class SoulGitStore {
  constructor(
    private readonly soulPath: string,
    private readonly signer: CommitSigner,
    private readonly logger: Logger
  ) {}

  private git(indexFile?: string, extraEnv?: Record<string, string>): SimpleGit {
    const git = simpleGit(this.soulPath, { timeout: { block: GIT_TIMEOUT_MS } });
    return git.env(
      hermeticGitEnv({
        ...(indexFile !== undefined ? { GIT_INDEX_FILE: indexFile } : {}),
        ...extraEnv,
      })
    );
  }

  /**
   * CAS targets HEAD's actual branch; assuming `main` breaks fresh repos initialized as
   * `master`.
   */
  private async branchRef(): Promise<string> {
    let ref: string;
    try {
      ref = (await this.git().raw(["symbolic-ref", "--quiet", "HEAD"])).trim();
    } catch (error) {
      throw new SoulGitStoreError(
        "BRANCH_UNRESOLVED",
        `Soul git store: HEAD is detached — refusing to publish onto no branch (${errText(error)})`,
        { cause: error }
      );
    }
    if (!ref.startsWith("refs/heads/")) {
      throw new SoulGitStoreError(
        "BRANCH_UNRESOLVED",
        `Soul git store: HEAD does not point at a branch (${ref || "detached"})`
      );
    }
    return ref;
  }

  async head(): Promise<string | null> {
    try {
      return (await this.git().revparse(["HEAD"])).trim();
    } catch {
      return null;
    }
  }

  /**
   * The base a changeset should declare to build on the current tip. Unlike `head()`, an unborn
   * branch is reported as the zero-OID sentinel so the value is always a valid changeset field.
   */
  async baseCommit(): Promise<string> {
    return (await this.head()) ?? SOUL_UNBORN_BASE;
  }

  /** Read a tracked file's content, or null when it does not exist. Path must be Soul-relative. */
  readFile(path: string): string | null {
    const resolved = this.resolveExistingPath(path);
    if (resolved === null) return null;
    try {
      if (!statSync(resolved).isFile()) return null;
      return readFileSync(resolved, "utf8");
    } catch {
      return null;
    }
  }

  /** Whether a Soul-relative path currently exists in the working tree. */
  exists(path: string): boolean {
    return this.resolveExistingPath(path) !== null;
  }

  /** Every Soul-relative file path under `directory`, recursively. Empty when absent. */
  listFiles(directory: string): string[] {
    const resolved = this.resolveExistingPath(directory);
    if (resolved === null) return [];
    const out: string[] = [];
    const walk = (abs: string, rel: string): void => {
      for (const entry of readdirSync(abs, { withFileTypes: true })) {
        if (entry.name === ".git") continue;
        const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
        const childAbs = join(abs, entry.name);
        if (entry.isSymbolicLink()) {
          if (this.resolveExistingPath(childRel) === null) continue;
          if (statSync(childAbs).isFile()) out.push(childRel);
          else if (statSync(childAbs).isDirectory()) walk(childAbs, childRel);
        } else if (entry.isDirectory()) walk(childAbs, childRel);
        else if (entry.isFile()) out.push(childRel);
      }
    };
    if (!statSync(resolved).isDirectory()) return [];
    walk(resolved, directory);
    return out.sort();
  }

  /** Contain Soul-relative paths inside the repo for reads and writes; reject traversal. */
  private resolvePath(path: string): string | null {
    if (path === "" || path.startsWith("/") || path.includes("\\") || path.includes("\0")) {
      return null;
    }
    const root = resolve(this.soulPath);
    const target = resolve(root, path);
    if (target !== root && !target.startsWith(`${root}${sep}`)) return null;
    return target;
  }

  private resolveExistingPath(path: string): string | null {
    const lexical = this.resolvePath(path);
    if (lexical === null || !existsSync(lexical)) return null;
    try {
      const root = realpathSync(this.soulPath);
      const target = realpathSync(lexical);
      if (target !== root && !target.startsWith(`${root}${sep}`)) return null;
      return lexical;
    } catch {
      return null;
    }
  }

  private validatedFiles(
    validated: ValidatedSoulChangeset,
    files: readonly SoulFileChange[]
  ): SoulFileChange[] {
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
      const parsed = parseSoulFile(file);
      if (!parsed.parsed || parsed.parsed.hash !== validatedFile.hash) {
        throw new SoulGitStoreError(
          "CONTENT_MISMATCH",
          `Soul git store: content at index ${index} changed after validation`
        );
      }
    });
    return files.map((file) => {
      if (file.operation === "delete") return file;
      const parsed = parseSoulFile(file).parsed;
      if (parsed?.definition === undefined) return file;
      return { ...file, content: `${parsed.definition.canonical}\n` };
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

  private async materializeCommit(
    commitSha: string,
    files: readonly SoulFileChange[]
  ): Promise<void> {
    const upsertPaths = files
      .filter((file) => file.operation === "upsert")
      .map((file) => file.path);
    const deletePaths = files
      .filter((file) => file.operation === "delete")
      .map((file) => file.path);

    if (upsertPaths.length > 0) {
      await this.git().raw([
        "restore",
        "--source",
        commitSha,
        "--staged",
        "--worktree",
        "--",
        ...upsertPaths,
      ]);
    }
    if (deletePaths.length > 0) {
      await this.git().raw(["rm", "-f", "--ignore-unmatch", "--", ...deletePaths]);
      for (const path of deletePaths) {
        const resolved = this.resolvePath(path);
        if (resolved === null) continue;
        rmSync(resolved, { force: true });
        this.pruneEmptyParents(path);
      }
    }
  }

  private pruneEmptyParents(path: string): void {
    const parts = path.split("/");
    parts.pop();
    while (parts.length > 0) {
      const directory = this.resolvePath(parts.join("/"));
      if (directory === null) return;
      try {
        rmdirSync(directory);
      } catch {
        return;
      }
      parts.pop();
    }
  }

  /** Atomically publish a signed commit; failures leave no partial tree visible. */
  async commitChangeset(request: SoulCommitRequest): Promise<SoulCommitResult> {
    const { changeset, files, actor, approval } = request;
    if (actor.principalId !== changeset.principalId) {
      throw new SoulGitStoreError(
        "ACTOR_MISMATCH",
        "Soul git store: commit actor does not match the validated changeset principal"
      );
    }
    const canonicalFiles = this.validatedFiles(changeset, files);

    const expected = isUnbornBase(changeset.expectedBaseCommit)
      ? null
      : changeset.expectedBaseCommit;
    const parentSha = await this.head();
    if (parentSha !== expected) {
      throw new SoulGitStoreError(
        "BASE_MISMATCH",
        `Soul git store: expected base ${expected ?? "(none)"} but HEAD is ${parentSha ?? "(none)"}`
      );
    }

    const scratchRoot = join(this.soulPath, ".git", "tulipfarm-changesets");
    mkdirSync(scratchRoot, { recursive: true });
    const workDir = mkdtempSync(join(scratchRoot, "changeset-"));
    const indexFile = join(workDir, "index");
    try {
      let treeSha: string;
      try {
        treeSha = await this.writeTree(workDir, indexFile, parentSha, canonicalFiles);
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

      const refArgs = ["update-ref", await this.branchRef(), commitSha];
      refArgs.push(parentSha ?? ZERO_OID);
      try {
        await this.git().raw(refArgs);
      } catch (error) {
        throw new SoulGitStoreError(
          "REF_UPDATE_FAILED",
          `Soul git store: base moved under the write (concurrent commit) — ${errText(error)}`,
          { cause: error }
        );
      }

      try {
        await this.materializeCommit(commitSha, canonicalFiles);
      } catch (error) {
        throw new SoulGitStoreError(
          "POST_COMMIT_CLEANUP_FAILED",
          `Soul git store: committed ${commitSha} but failed to materialize the working tree — ${errText(error)}`,
          { cause: error }
        );
      }

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
