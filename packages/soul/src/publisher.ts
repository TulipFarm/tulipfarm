import type { ExecutionBundle } from "./bundle";
import type { CommitActor } from "./commit-signing";
import type { BundleCompileRequest } from "./compiler";
import type { SoulPublicationCoordinator, SoulTreeReader } from "./publication";
import { type BundleSigner, signExecutionBundle } from "./signatures";
import type { Logger } from "./types";

export type ExecutionBundleCompiler = (request: BundleCompileRequest) => ExecutionBundle;

/** The Git facts {@link SoulPublisher.reconcile} needs, kept as a port so tests need no real repo. */
export interface SoulPublisherGitState {
  /** Current HEAD commit sha, or `undefined` when the repo has no commits yet. */
  headSha(): Promise<string | undefined>;
  /** Whether `sha` still resolves to a commit — `false` after a history rewrite dropped it. */
  hasCommit(sha: string): Promise<boolean>;
}

export interface SoulPublisherOptions {
  readonly treeReader: SoulTreeReader;
  readonly compiler: ExecutionBundleCompiler;
  readonly signer: BundleSigner;
  readonly coordinator: Pick<SoulPublicationCoordinator, "publish">;
  readonly logger: Logger;
  readonly businessId: string;
  /** Required only by {@link SoulPublisher.reconcile}; `publishCommittedTree` does not use it. */
  readonly gitState?: SoulPublisherGitState;
  /** The commit the active bundle pins, or `undefined` when nothing is active or it is unreadable. */
  readonly activeCommitSha?: (businessId: string) => Promise<string | undefined>;
}

export interface PublishCommittedTreeRequest {
  readonly commitSha: string;
  readonly actor: CommitActor;
}

/**
 * Turns one durable Soul git commit into the immutable execution bundle read side.
 *
 * The class owns no concrete IO: callers inject the committed-tree reader, compiler, signer, and
 * coordinator so the API can compose production ports while tests use in-memory ones.
 */
export class SoulPublisher {
  constructor(private readonly options: SoulPublisherOptions) {}

  async publishCommittedTree(request: PublishCommittedTreeRequest): Promise<void> {
    const startedAt = Date.now();
    const documents = await this.options.treeReader.readDefinitions(request.commitSha);
    const files = await this.options.treeReader.readFiles?.(request.commitSha);
    const bundle = this.options.compiler({
      businessId: this.options.businessId,
      changesetId: request.commitSha,
      commitSha: request.commitSha,
      documents,
      ...(files === undefined ? {} : { files }),
    });
    const signed = signExecutionBundle(bundle, this.options.signer);
    await this.options.coordinator.publish({ bundle: signed, actor: request.actor });
    this.options.logger.info(
      `Soul publisher: committed tree ${request.commitSha} enqueued as ${signed.digest} in ${Date.now() - startedAt}ms`
    );
  }

  /**
   * Bring `soul_active_bundles` back in step with git HEAD — the single reconciliation point for
   * every way HEAD can move without the post-commit hook firing. Both first boot of a
   * never-published deployment and commits arriving over remote sync leave the active bundle
   * behind git; publishing whatever HEAD points at now heals both. Idempotent and cheap when
   * already in step, so it is safe to call on every boot and every pull.
   */
  async reconcile(businessId: string, actor: CommitActor): Promise<void> {
    const gitState = this.options.gitState;
    if (gitState === undefined) {
      throw new Error("SoulPublisher.reconcile requires a gitState port");
    }
    const head = await gitState.headSha();
    if (head === undefined) {
      this.options.logger.warn(
        "Soul publisher: reconcile skipped — repo has no commits to publish yet"
      );
      return;
    }
    const activeCommitSha =
      this.options.activeCommitSha === undefined
        ? undefined
        : await this.options.activeCommitSha(businessId);
    if (activeCommitSha === undefined) {
      this.options.logger.info(
        `Soul publisher: no active bundle for ${businessId} — publishing HEAD ${head}`
      );
      await this.publishCommittedTree({ commitSha: head, actor });
      return;
    }
    if (activeCommitSha === head) return;
    if (await gitState.hasCommit(activeCommitSha)) {
      this.options.logger.info(
        `Soul publisher: active bundle pins ${activeCommitSha} but HEAD is ${head} — publishing HEAD`
      );
    } else {
      this.options.logger.error(
        `Soul publisher: active bundle pins ${activeCommitSha}, absent from the repo (history rewritten?) — publishing HEAD ${head}`
      );
    }
    await this.publishCommittedTree({ commitSha: head, actor });
  }
}
