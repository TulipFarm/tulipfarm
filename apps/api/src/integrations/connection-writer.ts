import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SecretsService } from "@tulipfarm/secrets";
import {
  authFlowSatisfied,
  type CommitActor,
  type GitSyncService,
  type IntegrationManifest,
  type SoulLoader,
} from "@tulipfarm/soul";
import { stringify as stringifyYaml } from "yaml";
import { resolveConnectionEnv, sealConnectionEnv } from "./connection-env";

/**
 * The one writer of an Integration's `connection.yaml`. Both the operator-driven connect route and
 * the auth broker's callback land here, so sealing, the definition of "connected", the commit, and
 * the Soul reload happen the same way regardless of whether a human pasted a token or a provider
 * redirect produced one.
 */

export interface ConnectionWriterDeps {
  gitSync: GitSyncService;
  soulLoader: SoulLoader;
  secrets: SecretsService;
}

/** Connection env with `secret://` refs resolved to plaintext, for steps that need credentials. */
export async function readConnectionEnv(
  deps: ConnectionWriterDeps,
  slug: string
): Promise<Record<string, string>> {
  const stored = deps.soulLoader.integrations.get(slug)?.connection?.env ?? {};
  return resolveConnectionEnv(stored, deps.secrets);
}

export interface MergeConnectionEnvInput {
  slug: string;
  manifest: IntegrationManifest;
  /** Values to merge in. An empty string is a real value: it clears a field the operator blanked. */
  patch: Record<string, string>;
  commitMessage: string;
  actor?: CommitActor;
}

export interface MergeConnectionEnvResult {
  enabled: boolean;
  /** True only when this write completed the flow, so post-connect wiring runs once, not per step. */
  connectedNow: boolean;
}

/**
 * Merges values into the stored connection env, seals secrets, commits, and reloads Soul.
 *
 * Merging rather than replacing is what makes multi-step flows possible: a GitHub App conversion
 * writes the App credentials and the install redirect that follows writes the installation id —
 * the second write must not erase the first.
 */
export async function mergeConnectionEnv(
  deps: ConnectionWriterDeps,
  input: MergeConnectionEnvInput
): Promise<MergeConnectionEnvResult> {
  const existing = deps.soulLoader.integrations.get(input.slug)?.connection;
  // Existing values stay in their sealed `secret://` form — sealConnectionEnv passes refs through,
  // so a merge never re-reads or rewrites a secret it was not handed.
  const merged = { ...(existing?.env ?? {}), ...input.patch };
  const sealed = await sealConnectionEnv(input.slug, input.manifest, merged, deps.secrets);

  // Checked against the sealed map on purpose: satisfaction only asks whether each value is
  // present, and a `secret://` ref is as present as the plaintext it stands for. Resolving every
  // secret here would decrypt credentials this function has no reason to read.
  const enabled = authFlowSatisfied(input.manifest, sealed);

  const dir = join(deps.gitSync.path, "integrations", input.slug);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "connection.yaml"), stringifyYaml({ enabled, env: sealed }), "utf8");
  await deps.gitSync.withSync(input.commitMessage, input.actor);
  await deps.soulLoader.reload();

  return { enabled, connectedNow: enabled && existing?.enabled !== true };
}
