import { canonicalHash } from "@tulipfarm/schema";
import type { ExecutionBundle } from "./bundle";
import type { CommitActor } from "./commit-signing";
import type { BundleCompileContribution, BundleCompileRequest } from "./compiler";
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
  /** Code-owned artifacts included in every publication without mutating the authored Soul. */
  readonly contributions?: () => Promise<readonly BundleCompileContribution[]>;
  /** Active signed bundle digest, used to detect contribution changes at an unchanged Git HEAD. */
  readonly activeBundleDigest?: (businessId: string) => Promise<string | undefined>;
}

export interface PublishCommittedTreeRequest {
  readonly commitSha: string;
  readonly actor: CommitActor;
}

/** Compile, sign, and enqueue publication for one durable Soul git commit. */
export class SoulPublisher {
  constructor(private readonly options: SoulPublisherOptions) {}

  private changesetId(
    commitSha: string,
    contributions: readonly BundleCompileContribution[] | undefined
  ): string {
    if (contributions === undefined || contributions.length === 0) return commitSha;
    const contributionRevision = canonicalHash(
      contributions
        .map((contribution) => ({
          source: contribution.source,
          documents: contribution.documents.map((document) => canonicalHash(document)).sort(),
          files: contribution.files
            .map((file) => ({ path: file.path, digest: canonicalHash(file.content) }))
            .sort((left, right) => left.path.localeCompare(right.path)),
        }))
        .sort((left, right) => left.source.localeCompare(right.source))
    );
    return `${commitSha}:contribution:${contributionRevision}`;
  }

  private async compileCommittedTree(commitSha: string) {
    const documents = await this.options.treeReader.readDefinitions(commitSha);
    const files = await this.options.treeReader.readFiles?.(commitSha);
    const contributions = await this.options.contributions?.();
    const bundle = this.options.compiler({
      businessId: this.options.businessId,
      changesetId: this.changesetId(commitSha, contributions),
      commitSha,
      documents,
      ...(files === undefined ? {} : { files }),
      ...(contributions === undefined ? {} : { contributions }),
    });
    return signExecutionBundle(bundle, this.options.signer);
  }

  private async publishSigned(
    signed: ReturnType<typeof signExecutionBundle>,
    actor: CommitActor,
    startedAt: number
  ): Promise<void> {
    const bundle = signed.bundle;
    await this.options.coordinator.publish({ bundle: signed, actor });
    // Enqueueing is not publishing. Every surface reads the *active* digest, so returning here
    // would let a caller announce an artifact the Runtime has not started serving — and if the
    // publication then dead-letters, never will.
    const stage = await this.options.coordinator.settle(
      bundle.changesetId,
      INLINE_PUBLICATION_CONSUMER
    );
    if (stage !== "active") {
      throw new Error(
        `Soul publisher: committed tree ${bundle.commitSha} was enqueued as ${signed.digest} but publication stopped at stage ${stage}; the Runtime keeps serving the previous bundle until a drain completes it`
      );
    }
    this.options.logger.info(
      `Soul publisher: committed tree ${bundle.commitSha} activated as ${signed.digest} in ${Date.now() - startedAt}ms`
    );
  }

  async publishCommittedTree(request: PublishCommittedTreeRequest): Promise<void> {
    const startedAt = Date.now();
    const signed = await this.compileCommittedTree(request.commitSha);
    await this.publishSigned(signed, request.actor, startedAt);
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
    if (activeCommitSha === head) {
      if (this.options.contributions === undefined) return;
      const startedAt = Date.now();
      const signed = await this.compileCommittedTree(head);
      if ((await this.options.activeBundleDigest?.(businessId)) === signed.digest) return;
      await this.publishSigned(signed, actor, startedAt);
      return;
    }
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
