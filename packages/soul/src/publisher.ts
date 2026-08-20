import type { ExecutionBundle } from "./bundle";
import type { CommitActor } from "./commit-signing";
import type { BundleCompileRequest } from "./compiler";
import type { SoulPublicationCoordinator, SoulTreeReader } from "./publication";
import { type BundleSigner, signExecutionBundle } from "./signatures";
import type { Logger } from "./types";

export type ExecutionBundleCompiler = (request: BundleCompileRequest) => ExecutionBundle;

/** Names the write path in the outbox ledger so an inline settle is told apart from a drain. */
const INLINE_PUBLICATION_CONSUMER = "soul.publisher.inline";

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
  readonly coordinator: Pick<SoulPublicationCoordinator, "publish" | "settle">;
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

/** Compile, sign, and enqueue publication for one durable Soul git commit. */
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
    // Enqueueing is not publishing. Every surface reads the *active* digest, so returning here
    // would let a caller announce an artifact the Runtime has not started serving — and if the
    // publication then dead-letters, never will.
    const stage = await this.options.coordinator.settle(
      bundle.changesetId,
      INLINE_PUBLICATION_CONSUMER
    );
    if (stage !== "active") {
      throw new Error(
        `Soul publisher: committed tree ${request.commitSha} was enqueued as ${signed.digest} but publication stopped at stage ${stage}; the Runtime keeps serving the previous bundle until a drain completes it`
      );
    }
    this.options.logger.info(
      `Soul publisher: committed tree ${request.commitSha} activated as ${signed.digest} in ${Date.now() - startedAt}ms`
    );
  }

  /** Reconcile active bundles with git HEAD; first boot may run before migrations finish. */
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
