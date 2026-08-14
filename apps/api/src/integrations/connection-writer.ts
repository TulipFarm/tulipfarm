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

/** Sole `connection.yaml` writer; connect routes and auth callbacks share sealing and reload. */

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
  /** Values to merge in; empty string clears a field the operator blanked. */
  patch: Record<string, string>;
  commitMessage: string;
  actor?: CommitActor;
}

export interface MergeConnectionEnvResult {
  enabled: boolean;
  /** True only when this write completed the flow, so post-connect wiring runs once. */
  connectedNow: boolean;
}

/** Merge env values so later auth steps do not erase earlier sealed credentials. */
export async function mergeConnectionEnv(
  deps: ConnectionWriterDeps,
  input: MergeConnectionEnvInput
): Promise<MergeConnectionEnvResult> {
  const existing = deps.soulLoader.integrations.get(input.slug)?.connection;
  // Keep existing `secret://` refs sealed; do not re-read secrets this write was not handed.
  const merged = { ...(existing?.env ?? {}), ...input.patch };
  const sealed = await sealConnectionEnv(input.slug, input.manifest, merged, deps.secrets);

  // Check satisfaction against sealed refs so this path does not decrypt credentials unnecessarily.
  const enabled = authFlowSatisfied(input.manifest, sealed);

  const dir = join(deps.gitSync.path, "integrations", input.slug);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "connection.yaml"), stringifyYaml({ enabled, env: sealed }), "utf8");
  await deps.gitSync.withSync(input.commitMessage, input.actor);
  await deps.soulLoader.reload();

  return { enabled, connectedNow: enabled && existing?.enabled !== true };
}
