import { artifactDirectory } from "@tulipfarm/schema";
import type { CommitActor } from "../commit-signing";
import type { SoulGitStore } from "../git-store";
import type { SoulBundlePublishPort, SoulWriter } from "../writer";
import { createOimSoulReleasePackageWriter } from "./oim-release-package";

export interface GitBackedOimSoulReleasePackageWriterDeps {
  readonly soulWriter: SoulWriter;
  readonly soulStore: Pick<SoulGitStore, "lastCommitForPath" | "listFiles">;
  readonly publisher: SoulBundlePublishPort;
  readonly actor: CommitActor;
}

export function createGitBackedOimSoulReleasePackageWriter(
  deps: GitBackedOimSoulReleasePackageWriterDeps
) {
  return createOimSoulReleasePackageWriter({
    soulWriter: deps.soulWriter,
    soulStore: deps.soulStore,
    currentArtifactRevision: (slug) =>
      deps.soulStore.lastCommitForPath(artifactDirectory("Integration", slug)),
    publication: {
      async ensurePublished(revision) {
        await deps.publisher.publishCommittedTree({ commitSha: revision, actor: deps.actor });
      },
    },
    actor: deps.actor,
  });
}
