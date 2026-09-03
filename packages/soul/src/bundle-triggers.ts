import { canonicalHash, definitions, isRecord } from "@tulipfarm/schema";
import type { BundleDefinition, RuntimeBundle } from "./bundle";

/**
 * Reading Triggers out of the Routines that own them.
 *
 * Triggers are authored inside `Routine.spec.triggers`, but the scheduler, the webhook resolver
 * and the invoke route each address a Trigger on its own. This is the only place that bridges the
 * two views, so no caller has to scan for a `kind: "Trigger"` definition — a bundle carries none,
 * and a leftover scan would silently find nothing rather than fail.
 *
 * The projection reads the authored record directly instead of validating the Routine, because it
 * runs on every scheduler tick and the tree reader already refused any document that does not
 * validate before it could reach a bundle.
 */

/** Every Trigger in the bundle, shaped like the standalone definition the resolvers consume. */
export function bundleTriggerDefinitions(
  bundle: Pick<RuntimeBundle, "definitions"> | undefined
): readonly BundleDefinition[] {
  const synthesized: BundleDefinition[] = [];
  for (const definition of bundle?.definitions ?? []) {
    if (definition.kind !== "Routine") continue;
    const routine = definition.document;
    const metadata = isRecord(routine.metadata) ? routine.metadata : {};
    const spec = isRecord(routine.spec) ? routine.spec : {};
    if (!Array.isArray(spec.triggers)) continue;

    const routineSlug = typeof metadata.slug === "string" ? metadata.slug : definition.slug;
    const authoredVersion =
      typeof metadata.authoredVersion === "number"
        ? metadata.authoredVersion
        : definition.authoredVersion;

    for (const authored of spec.triggers) {
      if (!isRecord(authored) || typeof authored.name !== "string") continue;
      const { name, ...triggerSpec } = authored;
      const document = {
        apiVersion: routine.apiVersion,
        kind: "Trigger",
        metadata: {
          id: definitions.routineTriggers.embeddedTriggerId(definition.id, name),
          slug: name,
          schemaVersion: metadata.schemaVersion,
          authoredVersion,
          lifecycle: metadata.lifecycle,
        },
        spec: {
          ...triggerSpec,
          // Containment is the authority for the target, so a projected ref can never dangle.
          routineRef: { name: routineSlug, version: String(authoredVersion) },
        },
      } as unknown as BundleDefinition["document"];

      synthesized.push({
        kind: "Trigger",
        id: definitions.routineTriggers.embeddedTriggerId(definition.id, name),
        slug: name,
        authoredVersion,
        hash: canonicalHash(document),
        document,
        // The owning Routine already carries every reference the Trigger can reach.
        references: [],
      });
    }
  }
  return synthesized;
}

/** The Trigger a public address names, or `undefined` when no Routine publishes that name. */
export function findBundleTrigger(
  bundle: Pick<RuntimeBundle, "definitions"> | undefined,
  name: string
): BundleDefinition | undefined {
  if (name.length === 0) return undefined;
  return bundleTriggerDefinitions(bundle).find((definition) => definition.slug === name);
}
