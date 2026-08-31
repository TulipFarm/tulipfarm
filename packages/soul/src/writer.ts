import { randomUUID } from "node:crypto";
import {
  type ArtifactKind,
  artifactDirectory,
  artifactLayout,
  classifySoulPath,
  companionPath,
  definitionPath,
  legacyDefinitionPaths,
} from "@tulipfarm/schema";
import {
  isUnbornBase,
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
import type { SoulTreeReader } from "./publication";
import { asAuthored, type SoulSemanticIssue, SoulSemanticValidationError } from "./refs";
import { validateSoulSemantics } from "./semantic";
import { isBundledDefinitionPath } from "./tree-reader";
import type { Logger } from "./types";
import { validateChangesetFiles } from "./validate";

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
  /**
   * Which definition file to address. Defaults to the canonical one.
   *
   * `"legacy"` names the superseded file for kinds that still have one (`AGENT.md`, `schema.yml`,
   * `manifest.yml`). It exists so a surface whose on-disk format has not been migrated yet can
   * still write *through this gateway* rather than around it — an unwritable format is precisely
   * the pressure that produces a raw-filesystem bypass. Either way exactly one definition may
   * survive, so this selects the format; it never permits both.
   */
  readonly definitionMode?: "canonical" | "legacy";
}

export type SoulWrite =
  | { readonly op: "put"; readonly target: SoulWriteTarget; readonly content: string }
  | { readonly op: "delete"; readonly target: SoulWriteTarget }
  /** Remove an entire artifact — its definition and every companion beside it. */
  | { readonly op: "deleteArtifact"; readonly kind: ArtifactKind; readonly slug: string };

/**
 * The target that addresses `path` inside an artifact's own directory.
 *
 * An installer holds a package's relative paths, not targets, and the definition file is the one
 * path the gateway refuses as a companion. Deciding it here keeps every installer from re-deriving
 * which filename a layout calls its definition — a package that ships its own `SKILL.md` was
 * otherwise rejected whole.
 */
export function artifactWriteTarget(
  kind: ArtifactKind,
  slug: string,
  path: string
): SoulWriteTarget {
  return artifactLayout(kind)?.definitionFile === path
    ? { kind, slug }
    : { kind, slug, companion: path };
}

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
  /**
   * Whether the committed tree became the published runtime bundle. The commit is durable either
   * way, but while this is false the Runtime keeps serving the previous bundle, so a caller must
   * not report the artifact as live.
   */
  readonly published: boolean;
  /** Why publication did not land, when `published` is false. Carries no file content. */
  readonly publicationError?: string;
}

/** Outcome of the post-commit publication attempt, as {@link SoulWriteResult} reports it. */
interface BundlePublicationOutcome {
  readonly published: boolean;
  readonly publicationError?: string;
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
 * Publish the committed tree as a signed runtime bundle.
 *
 * The gateway commits through `SoulGitStore`, not `GitSyncService`, so it must discharge the
 * publication obligation `afterSuccessfulCommit` normally carries — without this port a write
 * lands the commit and silently leaves `soul_active_bundles` stale.
 */
export interface SoulBundlePublishPort {
  publishCommittedTree(input: { commitSha: string; actor: CommitActor }): Promise<unknown>;
}

/** Single authored-Soul write gateway: validate, atomically commit, publish, push, then reload. */
export class SoulWriter {
  constructor(
    private readonly store: SoulGitStore,
    private readonly logger: Logger,
    private readonly push?: SoulPushPort,
    private readonly reload?: SoulReloadPort,
    private readonly publisher?: SoulBundlePublishPort,
    /**
     * Reads the authored tree at a commit, so a changeset's cross-definition references (a
     * Routine's `agentRef`/`toolRef`/`formRef`/`child_routine.routineRef`, an Agent's `roles`, …)
     * can be checked before committing. Without it, a bad reference still lands in the Soul commit
     * and is only discovered later — as an opaque post-commit publication failure.
     */
    private readonly treeReader?: Pick<SoulTreeReader, "readDefinitions">
  ) {}

  /** Whether a collection artifact currently exists (its definition file is present). */
  exists(kind: ArtifactKind, slug?: string): boolean {
    try {
      return this.store.exists(definitionPath(kind, slug));
    } catch {
      // An unreadable tree reports the artifact as absent.
      return false;
    }
  }

  /** Read an artifact's definition file, or null when absent. */
  read(kind: ArtifactKind, slug?: string): string | null {
    try {
      return this.store.readFile(definitionPath(kind, slug));
    } catch {
      // A missing definition file resolves to "absent".
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
      // A missing companion file resolves to "absent".
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

  /** Validate and commit; `CONFLICT` requires re-read and recompute, not retrying stale bytes. */
  async apply(request: SoulWriteRequest): Promise<SoulWriteResult> {
    const files = this.resolveChanges(request.changes);
    if (files.length === 0) {
      throw new SoulWriteError("INVALID_TARGET", "Soul write: no file changes were resolved");
    }
    this.checkPreconditions(request.preconditions ?? []);

    const currentBaseCommit = await this.store.baseCommit();
    await this.checkReferences(files, currentBaseCommit);
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
    const publication = await this.publishBundle(result, request.actor, changeset.id);
    await this.refresh(changeset.id);
    return {
      commitSha: result.commitSha,
      filesChanged: result.filesChanged,
      paths: files.map((file) => file.path),
      pushed,
      ...publication,
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
   * Refuse a definition write while the other form survives for the same artifact. Two definitions
   * is an ambiguity the loader can only resolve by guessing, and the writer will not delete the
   * other itself: the forms carry content in different shapes, so migration must be stated. Runs
   * in both directions.
   */
  private checkNoAmbiguousDefinition(
    changes: readonly SoulWrite[],
    paths: ReadonlySet<string>
  ): void {
    for (const change of changes) {
      if (change.op !== "put" || change.target.companion !== undefined) continue;
      const { kind, slug } = change.target;
      const superseded =
        change.target.definitionMode === "legacy"
          ? [this.buildPath(() => definitionPath(kind, slug))]
          : this.buildLegacyDefinitionPaths(kind, slug);
      const surviving = superseded.filter((path) => !paths.has(path) && this.store.exists(path));
      if (surviving.length > 0) {
        throw new SoulWriteError(
          "PRECONDITION_FAILED",
          `Soul write: ${kind} "${slug ?? ""}" still has a superseded definition at ${surviving.join(", ")}; the changeset must remove it`
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
    if (target.definitionMode === "legacy") return this.legacyDefinitionPath(kind, slug);
    return this.buildPath(() => definitionPath(kind, slug));
  }

  /**
   * The single superseded definition path for a kind that still has one. A kind with no legacy
   * form, or with several, cannot be addressed this way — the caller would be guessing which file
   * the read side resolves.
   */
  private legacyDefinitionPath(kind: ArtifactKind, slug?: string): string {
    const candidates = this.buildLegacyDefinitionPaths(kind, slug);
    if (candidates.length !== 1) {
      throw new SoulWriteError(
        "INVALID_TARGET",
        `Soul write: ${kind} has no single superseded definition file to address`
      );
    }
    return candidates[0];
  }

  private buildLegacyDefinitionPaths(kind: ArtifactKind, slug?: string): string[] {
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

  /**
   * Reject an unresolvable cross-definition reference before it is committed. Malformed content is
   * left to {@link validateSoulChangeset} — this only re-checks reference edges of files that
   * already parse, against the tree those files are about to land on.
   *
   * Uses the same `treeReader.readDefinitions` source as {@link SoulPublisher}'s post-commit
   * compiler, so it shares that source's blind spot: a still-legacy-format definition (`AGENT.md`,
   * `schema.yml`, `manifest.yml`) is invisible to both. This check is exactly as accurate as the
   * bundle compiler that would otherwise catch the same reference later — no less, no more.
   */
  private async checkReferences(
    files: readonly SoulFileChange[],
    baseCommit: string
  ): Promise<void> {
    if (this.treeReader === undefined) return;
    const { files: parsed, issues } = validateChangesetFiles(files);
    if (issues.length > 0) return;

    const touched = new Set<string>();
    for (const file of files) {
      if (!isBundledDefinitionPath(file.path)) continue;
      const location = classifySoulPath(file.path);
      if (location) touched.add(`${location.kind}\u0000${location.slug ?? ""}`);
    }

    const existing = isUnbornBase(baseCommit)
      ? []
      : await this.treeReader.readDefinitions(baseCommit);
    const kept = existing.filter((doc) => {
      const def = asAuthored(doc);
      return def === undefined || !touched.has(`${def.kind}\u0000${def.slug}`);
    });
    const proposed = parsed.flatMap((file) => (file.definition ? [file.definition.document] : []));

    try {
      validateSoulSemantics([...kept, ...proposed]);
    } catch (error) {
      if (!(error instanceof SoulSemanticValidationError)) throw error;
      // A pre-existing definition elsewhere in the tree can already be broken (e.g. a Routine left
      // pointing at a deleted Agent). That is not this changeset's fault, and blocking an unrelated
      // write on it leaves the operator unable to fix anything through chat. Only reject when the
      // changeset itself touches the definition an issue is reported against.
      const relevant = error.issues.filter((issue) => touched.has(issue.subject.replace(":", " ")));
      if (relevant.length === 0) return;
      const relevantError = new SoulSemanticValidationError(relevant);
      throw new SoulWriteError(
        "VALIDATION_FAILED",
        `Soul write: ${describeSemanticIssues(relevantError)}`,
        {
          cause: relevantError,
        }
      );
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
   * Publication failures never fail the write — the commit is already durable — but they are
   * reported, because an artifact that is committed and unpublished is invisible to every surface
   * that reads the active bundle. A caller that announced success on the commit alone would be
   * claiming an outcome the Runtime never reached.
   */
  private async publishBundle(
    result: SoulCommitResult,
    actor: CommitActor,
    changesetId: string
  ): Promise<BundlePublicationOutcome> {
    if (result.filesChanged === 0) return { published: true };
    if (this.publisher === undefined) {
      return {
        published: false,
        publicationError: "this Soul write gateway has no bundle publisher configured",
      };
    }
    try {
      await this.publisher.publishCommittedTree({ commitSha: result.commitSha, actor });
      return { published: true };
    } catch (error) {
      const reason = errText(error);
      this.logger.error(
        `Soul: committed ${result.commitSha} for changeset ${changesetId} but bundle publication failed; the Runtime keeps serving the previous bundle — ${reason}`
      );
      return { published: false, publicationError: reason };
    }
  }

  /** Reload failures are logged because the write is already durable. */
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

/**
 * What an issue code means for the caller. A pointer alone ("UNRESOLVED_REF at /spec/states/0") says
 * where the writer stopped but not what to do, and an authoring Agent answers that by guessing at
 * the reference's shape until its repair budget is gone. Naming the cause ends the guessing.
 *
 * `UNRESOLVED_REF` has no entry here: it is misleading to say once and for all that "the
 * definition does not exist" when it may simply be misnamed, so {@link describeSemanticIssues}
 * answers per issue instead, from that issue's own `candidates`.
 */
const ISSUE_REMEDIES: Partial<Record<SoulSemanticIssue["code"], string>> = {
  VERSION_UNSATISFIED:
    "the referenced definition exists at a different authored version — reference the version it " +
    "actually has",
  ROUTINE_START_UNKNOWN: "spec.start must name one of spec.states",
  ROUTINE_TRANSITION_UNKNOWN: "a transition names a State that does not exist",
};

/**
 * `UNRESOLVED_REF` guidance for one issue. Lists what the caller could have meant instead of
 * repeating the unhelpful "it does not exist" — the reference may well be a plain misnaming — and
 * only ever from `issue.candidates`, which is already scoped to this same changeset's own tree
 * (see {@link SoulSemanticIssue.candidates}), never a wider catalog.
 */
function unresolvedRefGuidance(issue: SoulSemanticIssue): string {
  if (issue.candidates === undefined || issue.candidates.length === 0) {
    return (
      "no definition of this kind exists in the Soul yet — create it first, then write the " +
      "definition that references it"
    );
  }
  return `did you mean one of: ${issue.candidates.join(", ")}?`;
}

function describeSemanticIssues(error: SoulSemanticValidationError): string {
  const described = error.issues.map((issue) => {
    const pointer = `${issue.subject} ${issue.code}${issue.ref ? ` (${issue.ref})` : ""}${issue.field ? ` at ${issue.field}` : ""}`;
    return issue.code === "UNRESOLVED_REF"
      ? `${pointer} — ${unresolvedRefGuidance(issue)}`
      : pointer;
  });
  const remedies = [
    ...new Set(
      error.issues.flatMap((issue) => {
        const remedy = ISSUE_REMEDIES[issue.code];
        return remedy === undefined ? [] : [`${issue.code}: ${remedy}`];
      })
    ),
  ];
  const detail = `${error.message}: ${described.join("; ")}`;
  return remedies.length === 0 ? detail : `${detail}. ${remedies.join(". ")}.`;
}
