import {
  type CommitActor,
  type CommitSigner,
  createHmacCommitSigner,
  type GitSyncService,
  type Logger,
  type SoulBundlePublishPort,
  SoulGitStore,
  type SoulTreeReader,
  SoulWriter,
} from "@tulipfarm/soul";
import { resolveSigningKey, type SigningKeyStore } from "../identity/signed-token";

/**
 * Composition for the authored-Soul write gateway (ADR-007).
 *
 * `SoulWriter` is the only door to the authored tree, but a gateway nothing constructs is a
 * gateway nothing uses. This module builds the one instance the API serves every authoring surface
 * from, and — critically — wires the three side effects a raw `fs.writeFile` + `git commit` pair
 * used to open-code: remote push, catalog reload, and runtime bundle publication.
 */

/** HMAC key covering commit provenance (actor, approval, schemas) — see `buildCommitSigningPayload`. */
export const SOUL_COMMIT_SIGNING_KEY = "soul-commit.hmac.signing-key";
export const SOUL_COMMIT_SIGNING_KEY_ID = "soul-commit-v1";

/**
 * Fallback actor for genuinely system-initiated Soul commits (format migrations, LLM Tool writes
 * with no request actor). Deliberately synthetic so the activation ledger never mistakes it for a
 * user. Lives here rather than in the composition root because every authoring surface needs it to
 * satisfy the gateway's required `actor`.
 */
export const SYSTEM_SOUL_COMMIT_ACTOR: CommitActor = {
  principalId: "service:tulipfarm-system",
  name: "TulipFarm (system)",
  email: "",
};

/**
 * Resolve the commit signer, provisioning its key on first use so a fresh deployment needs no
 * operator step. Unlike the bundle keypair this key is symmetric and verified only by this
 * deployment, so losing it invalidates historical signature *checks* but never orphans a commit —
 * the trailers stay readable either way.
 */
export async function resolveSoulCommitSigner(secrets: SigningKeyStore): Promise<CommitSigner> {
  const key = await resolveSigningKey(secrets, SOUL_COMMIT_SIGNING_KEY);
  return createHmacCommitSigner(SOUL_COMMIT_SIGNING_KEY_ID, key.toString("base64"));
}

export interface SoulWriterDeps {
  readonly soulPath: string;
  readonly signer: CommitSigner;
  readonly logger: Logger;
  /** Supplies the best-effort remote push; the gateway never fails a committed write on push. */
  readonly gitSync: Pick<GitSyncService, "push" | "hasRemote">;
  /** Re-reads the committed tree into the in-memory catalog. */
  readonly reload: () => Promise<unknown>;
  /**
   * Publishes the committed tree as a signed bundle. Required, not optional: the gateway commits
   * through `SoulGitStore`, so it never reaches `GitSyncService.afterSuccessfulCommit`, and a
   * composition that forgets this leaves the Runtime executing the previous tree.
   */
  readonly publisher: SoulBundlePublishPort;
  /** Checks a changeset's cross-definition references against the tree before it is committed. */
  readonly treeReader: Pick<SoulTreeReader, "readDefinitions">;
}

export function createSoulWriter(deps: SoulWriterDeps): SoulWriter {
  const store = new SoulGitStore(deps.soulPath, deps.signer, deps.logger);
  return new SoulWriter(
    store,
    deps.logger,
    {
      // `hasRemote` is a method on GitSyncService but a property on the port, so it is read at
      // call time rather than captured — a remote configured after boot must still be pushed to.
      get hasRemote(): boolean {
        return deps.gitSync.hasRemote();
      },
      push: () => deps.gitSync.push(),
    },
    { reload: deps.reload },
    deps.publisher,
    deps.treeReader
  );
}
