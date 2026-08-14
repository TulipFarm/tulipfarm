import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import type { SecretsService } from "@tulipfarm/secrets";
import {
  authFlowSatisfied,
  type CommitActor,
  type IntegrationManifest,
  type SoulLoader,
  type SoulWriter,
} from "@tulipfarm/soul";
import { stringify as stringifyYaml } from "yaml";
import { SYSTEM_SOUL_COMMIT_ACTOR } from "../runtime/soul-writer";
import { resolveConnectionEnv, sealConnectionEnv } from "./connection-env";

/** Sole `connection.yaml` writer; connect routes and auth callbacks share sealing and reload. */

export interface ConnectionWriterDeps {
  /** ADR-007 write gateway: the sole door for committing `connection.yaml`. */
  soulWriter: SoulWriter;
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

  // `connection.yaml` is a registered companion of an Integration (content mode `managed`), so it
  // is addressed as one — one atomic changeset through the gateway, which commits, pushes, and
  // reloads. The old `mkdir` + `writeFile` + `withSync` sequence is gone; the gateway owns the path.
  await deps.soulWriter.apply({
    subject: input.commitMessage,
    source: "api",
    actor: input.actor ?? SYSTEM_SOUL_COMMIT_ACTOR,
    businessId: DEPLOYMENT_BUSINESS_ID,
    changes: [
      {
        op: "put",
        target: { kind: "Integration", slug: input.slug, companion: "connection.yaml" },
        content: stringifyYaml({ enabled, env: sealed }),
      },
    ],
  });
  await deps.soulLoader.reload();

  return { enabled, connectedNow: enabled && existing?.enabled !== true };
}
