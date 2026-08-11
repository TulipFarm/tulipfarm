import { randomUUID } from "node:crypto";
import {
  type ArtifactKind,
  artifactDirectory,
  companionPath,
  definitionPath,
  legacyDefinitionPaths,
} from "@tulipfarm/schema";
import {
  type SoulChangeset,
  type SoulChangesetSource,
  SoulChangesetValidationError,
  type SoulChangesetValidationIssue,
  type SoulFileChange,
  validateSoulChangeset,
} from "./changeset";
import type { CommitActor, CommitApproval } from "./commit-signing";
import type { SoulCommitResult, SoulGitStore } from "./git-store";
import { SoulGitStoreError } from "./git-store";
import type { Logger } from "./types";

/**
 * Which file a write addresses. Callers name the *artifact*, never a path — the layout registry
 * derives the path, so a caller cannot invent one the read side would never look at.
 */
export interface SoulWriteTarget {
  readonly kind: ArtifactKind;
  /** Required for collection kinds (`agents`, `skills`, …); omitted for singletons (`soul.yaml`). */
  readonly slug?: string;
  /** Address a companion beside the definition (`hooks.ts`, `connection.yaml`, an egress spec). */
  readonly companion?: string;
}

export type SoulWrite =
  | { readonly op: "put"; readonly target: SoulWriteTarget; readonly content: string }
  | { readonly op: "delete"; readonly target: SoulWriteTarget }
  /** Remove an entire artifact — its definition and every companion beside it. */
  | { readonly op: "deleteArtifact"; readonly kind: ArtifactKind; readonly slug: string };

/** What must already be true of the tree for the write to be allowed to proceed. */
export type SoulPrecondition =
  | { readonly kind: ArtifactKind; readonly slug: string; readonly state: "absent" }
  | { readonly kind: ArtifactKind; readonly slug: string; readonly state: "present" };

export interface SoulWriteRequest {
  /** Commit subject. Conventional prefix (`soul: add agent x`) — the body is generated. */
  readonly subject: string;
  readonly source: SoulChangesetSource;
  readonly actor: CommitActor;
  readonly businessId: string;
  readonly changes: readonly SoulWrite[];
  readonly preconditions?: readonly SoulPrecondition[];
  /** Base revision observed by a caller's read before it computed this write. */
  readonly expectedBaseCommit?: string;
  /** The Approval decision that authorized this write, when the change required one. */
  readonly approval?: CommitApproval;
}

export interface SoulWriteResult {
  readonly commitSha: string;
  readonly filesChanged: number;
  /** Soul-relative paths the changeset touched, in commit order. */
  readonly paths: readonly string[];
  /** False when the commit landed locally but the remote push failed — the write is durable. */
  readonly pushed: boolean;
}

export interface SoulReadResult {
  readonly content: string | null;
  readonly baseCommit: string;
}

export type SoulWriteErrorCode =
  | "INVALID_TARGET"
  | "PRECONDITION_FAILED"
  | "VALIDATION_FAILED"
  | "CONFLICT"
  | "COMMIT_FAILED"
  | "POST_COMMIT_CLEANUP_FAILED";

/**
 * A write rejection carrying only structured evidence — never file content, so it is safe to log
 * and to return across the API boundary.
 */
export class SoulWriteError extends Error {
  readonly code: SoulWriteErrorCode;
  readonly issues: readonly SoulChangesetValidationIssue[];

  constructor(
    code: SoulWriteErrorCode,
    message: string,
    options?: { issues?: readonly SoulChangesetValidationIssue[]; cause?: unknown }
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "SoulWriteError";
    this.code = code;
    this.issues = Object.freeze([...(options?.issues ?? [])]);
  }
}

/** Best-effort remote publication. Push failure never fails a committed write (SOUL-V1-003). */
export interface SoulPushPort {
  push(): Promise<unknown>;
  readonly hasRemote: boolean;
}

/** Re-read the tree into the in-memory catalog so a committed write is immediately visible. */
export interface SoulReloadPort {
  reload(): Promise<unknown>;
}

/**
 * The single write gateway for the authored Soul tree.
 *
 * Every authoring surface — REST route, LLM Tool, importer, migration — reaches the tree through
 * `apply`, and through nothing else. That is what makes the validation gate real: it is not a
 * function a caller may remember to call, it is the only door. In exchange the caller is freed
 * from the five concerns it used to open-code (path building, existence checks, commit, push,
 * catalog reload), and gains the three it could not implement itself:
 *
 * - **Atomicity** — a multi-file artifact lands as one commit or not at all, so the tree never
 *   holds a manifest whose spec file is missing.
 * - **Conflict detection** — the write is a compare-and-swap against the base it was computed
 *   from, so a concurrent write or a down-sync pull is rejected rather than silently overwritten.
 * - **Provenance** — who, on whose authority, under which schema versions, signed into the commit.
 *
 * Nothing here decides *whether* a principal may write; authorization is resolved before `apply`
 * and arrives as `actor` and `approval`. This gateway decides only whether the bytes are valid and
 * lands them atomically.
 */
export class SoulWriter {
  constructor(
    private readonly store: SoulGitStore,
    private readonly logger: Logger,
    private readonly push?: SoulPushPort,
    private readonly reload?: SoulReloadPort
  ) {}

  /** Whether a collection artifact currently exists (its definition file is present). */
  exists(kind: ArtifactKind, slug?: string): boolean {
    try {
      return this.store.exists(definitionPath(kind, slug));
    } catch {
      return false;
    }
  }

  /** Read an artifact's definition file, or null when absent. */
  read(kind: ArtifactKind, slug?: string): string | null {
    try {
      return this.store.readFile(definitionPath(kind, slug));
    } catch {
      return null;
    }
  }

  async readWithBase(kind: ArtifactKind, slug?: string): Promise<SoulReadResult> {
    return this.readPathWithBase(definitionPath(kind, slug));
  }

  /** Read a companion file beside an artifact's definition, or null when absent. */
  readCompanion(kind: ArtifactKind, slug: string, name: string): string | null {
    try {
      return this.store.readFile(companionPath(kind, slug, name));
    } catch {
      return null;
    }
  }

  async readCompanionWithBase(
    kind: ArtifactKind,
    slug: string,
    name: string
  ): Promise<SoulReadResult> {
    return this.readPathWithBase(companionPath(kind, slug, name));
  }

  private async readPathWithBase(path: string): Promise<SoulReadResult> {
    for (let attempts = 0; attempts < 2; attempts += 1) {
      const before = await this.store.baseCommit();
      const content = this.store.readFile(path);
      const after = await this.store.baseCommit();
      if (before === after) return { content, baseCommit: before };
    }
    throw new SoulWriteError("CONFLICT", "Soul read: the tree changed during the read");
  }

  /**
   * Validate and atomically commit a proposed change to the Soul tree.
   *
   * Throws `SoulWriteError` on every rejection. A `CONFLICT` means the base moved under the write
   * — the caller must re-read and recompute, because its content was derived from a tree that no
   * longer exists. Retrying the same bytes would resurrect a stale read.
   */
  async apply(request: SoulWriteRequest): Promise<SoulWriteResult> {
    const files = this.resolveChanges(request.changes);
    if (files.length === 0) {
      throw new SoulWriteError("INVALID_TARGET", "Soul write: no file changes were resolved");
    }
    this.checkPreconditions(request.preconditions ?? []);

    const currentBaseCommit = await this.store.baseCommit();
    const expectedBaseCommit = request.expectedBaseCommit ?? currentBaseCommit;
    const changeset: SoulChangeset = {
      id: randomUUID(),
      businessId: request.businessId,
      principalId: request.actor.principalId,
      source: request.source,
      expectedBaseCommit,
      files,
    };

    let result: SoulCommitResult;
    try {
      result = await this.store.commitChangeset({
        changeset: validateSoulChangeset(changeset, currentBaseCommit),
        files,
        actor: request.actor,
        approval: request.approval,
        subject: request.subject,
      });
    } catch (error) {
      throw toWriteError(error);
    }

    const pushed = await this.publish(changeset.id);
    await this.refresh(changeset.id);
    return {
      commitSha: result.commitSha,
      filesChanged: result.filesChanged,
      paths: files.map((file) => file.path),
      pushed,
    };
  }

  /** Expand artifact-addressed changes into the concrete file changes a changeset carries. */
  private resolveChanges(changes: readonly SoulWrite[]): SoulFileChange[] {
    const files: SoulFileChange[] = [];
    const seen = new Set<string>();
    const add = (file: SoulFileChange): void => {
      if (seen.has(file.path)) {
        throw new SoulWriteError(
          "INVALID_TARGET",
          `Soul write: ${file.path} appears more than once in one changeset`
        );
      }
      seen.add(file.path);
      files.push(file);
    };

    for (const change of changes) {
      if (change.op === "deleteArtifact") {
        const directory = this.buildPath(() => artifactDirectory(change.kind, change.slug));
        const existing = this.store.listFiles(directory);
        if (existing.length === 0) {
          throw new SoulWriteError(
            "PRECONDITION_FAILED",
            `Soul write: ${change.kind} "${change.slug}" does not exist`
          );
        }
        for (const path of existing) add({ operation: "delete", path });
        continue;
      }
      const path = this.targetPath(change.target, change.op);
      if (change.op === "put") add({ operation: "upsert", path, content: change.content });
      else add({ operation: "delete", path });
    }
    this.checkNoAmbiguousDefinition(changes, seen);
    return files;
  }

  /**
   * Refuse to write a canonical definition while a superseded one for the same artifact survives.
   *
   * Two definitions for one artifact is an ambiguity the loader can only resolve by guessing. The
   * writer does not delete the old file on the caller's behalf: a legacy definition can carry
   * content the canonical form splits out (an `AGENT.md` body becomes `instructions.md`), so
   * removing it silently would discard authored prose. Migration must be stated, not inferred.
   */
  private checkNoAmbiguousDefinition(
    changes: readonly SoulWrite[],
    paths: ReadonlySet<string>
  ): void {
    for (const change of changes) {
      if (change.op !== "put" || change.target.companion !== undefined) continue;
      const legacy = legacyDefinitionPaths(change.target.kind, change.target.slug).filter(
        (path) => !paths.has(path) && this.store.exists(path)
      );
      if (legacy.length > 0) {
        throw new SoulWriteError(
          "PRECONDITION_FAILED",
          `Soul write: ${change.target.kind} "${change.target.slug ?? ""}" still has a superseded definition at ${legacy.join(", ")}; the changeset must remove it`
        );
      }
    }
  }

  private targetPath(target: SoulWriteTarget, operation: "put" | "delete"): string {
    const { kind, slug, companion } = target;
    if (companion !== undefined) {
      if (slug === undefined) {
        throw new SoulWriteError(
          "INVALID_TARGET",
          `Soul write: a companion of ${kind} requires a slug`
        );
      }
      const path = this.buildPath(() => companionPath(kind, slug, companion));
      const definitionPaths = new Set<string>([
        this.buildPath(() => definitionPath(kind, slug)),
        ...this.buildLegacyDefinitionPaths(kind, slug),
      ]);
      if (operation !== "delete" && definitionPaths.has(path)) {
        throw new SoulWriteError(
          "INVALID_TARGET",
          `Soul write: ${path} is a definition file, not a companion`
        );
      }
      return path;
    }
    return this.buildPath(() => definitionPath(kind, slug));
  }

  private buildLegacyDefinitionPaths(kind: ArtifactKind, slug: string): string[] {
    try {
      return legacyDefinitionPaths(kind, slug);
    } catch (error) {
      throw new SoulWriteError("INVALID_TARGET", `Soul write: ${errText(error)}`, {
        cause: error,
      });
    }
  }

  /**
   * Path builders throw rather than emit a path the gate would reject. Translate that into the
   * gateway's own error so a caller sees one failure vocabulary.
   */
  private buildPath(build: () => string): string {
    try {
      return build();
    } catch (error) {
      throw new SoulWriteError("INVALID_TARGET", `Soul write: ${errText(error)}`, { cause: error });
    }
  }

  private checkPreconditions(preconditions: readonly SoulPrecondition[]): void {
    for (const precondition of preconditions) {
      const present = this.exists(precondition.kind, precondition.slug);
      if (precondition.state === "absent" && present) {
        throw new SoulWriteError(
          "PRECONDITION_FAILED",
          `Soul write: ${precondition.kind} "${precondition.slug}" already exists`
        );
      }
      if (precondition.state === "present" && !present) {
        throw new SoulWriteError(
          "PRECONDITION_FAILED",
          `Soul write: ${precondition.kind} "${precondition.slug}" does not exist`
        );
      }
    }
  }

  private async publish(changesetId: string): Promise<boolean> {
    if (this.push === undefined || !this.push.hasRemote) return false;
    try {
      await this.push.push();
      return true;
    } catch (error) {
      this.logger.warn(`Soul: push after changeset ${changesetId} failed — ${errText(error)}`);
      return false;
    }
  }

  /**
   * Refresh the in-memory catalog. A failure here leaves a committed, durable write behind a stale
   * read — degraded but recoverable on the next sync — so it is logged, not thrown. Throwing would
   * report failure for a change that is already permanent.
   */
  private async refresh(changesetId: string): Promise<void> {
    if (this.reload === undefined) return;
    try {
      await this.reload.reload();
    } catch (error) {
      this.logger.error(
        `Soul: reload after changeset ${changesetId} failed; the catalog is stale until the next sync — ${errText(error)}`
      );
    }
  }
}

function toWriteError(error: unknown): SoulWriteError {
  if (error instanceof SoulWriteError) return error;
  if (error instanceof SoulChangesetValidationError) {
    return error.code === "BASE_MISMATCH"
      ? new SoulWriteError("CONFLICT", "Soul write: the tree changed under this write", {
          cause: error,
        })
      : new SoulWriteError("VALIDATION_FAILED", error.message, {
          issues: error.issues,
          cause: error,
        });
  }
  if (error instanceof SoulGitStoreError) {
    // Only a genuine compare-and-swap loss is a CONFLICT, because CONFLICT tells the caller to
    // re-read and recompute. A repository that cannot be published to at all (detached HEAD, no
    // branch) must not wear that label, or the caller retries forever against a permanent fault.
    const conflict = error.code === "BASE_MISMATCH" || error.code === "REF_UPDATE_FAILED";
    if (error.code === "POST_COMMIT_CLEANUP_FAILED") {
      return new SoulWriteError("POST_COMMIT_CLEANUP_FAILED", error.message, { cause: error });
    }
    return new SoulWriteError(
      conflict ? "CONFLICT" : "COMMIT_FAILED",
      conflict ? "Soul write: the tree changed under this write" : error.message,
      { cause: error }
    );
  }
  return new SoulWriteError("COMMIT_FAILED", `Soul write failed — ${errText(error)}`, {
    cause: error,
  });
}

function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
