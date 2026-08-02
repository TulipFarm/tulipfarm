import type { BundleDefinition, BundleStore, RuntimeBundle } from "./bundle";
import type { BundleSigner } from "./signatures";
import { verifyExecutionBundle } from "./signatures";

/** Exact authored identity a durable Run recorded when it was minted. */
export interface PinnedDefinitionRef {
  readonly businessId: string;
  readonly bundleDigest: string;
  readonly kind: string;
  readonly definitionId: string;
  readonly authoredVersion: number;
}

/** A definition opened only after its immutable bundle and signature were verified. */
export interface PinnedDefinition {
  readonly bundle: RuntimeBundle;
  readonly definition: BundleDefinition;
}

/**
 * Git-free exact-definition reader for durable execution.
 *
 * A Run pins all five identity fields above. This loader accepts only a stored bundle whose
 * signature is valid and whose definition matches every pin; it never consults the active alias,
 * so publishing a newer bundle cannot change a Run that is already queued or waiting.
 */
export class PinnedDefinitionLoader {
  constructor(
    private readonly bundles: Pick<BundleStore, "get">,
    private readonly signer: BundleSigner
  ) {}

  async load(ref: PinnedDefinitionRef): Promise<PinnedDefinition | undefined> {
    const record = await this.bundles.get(ref.bundleDigest);
    if (record === undefined) return undefined;

    const bundle = verifyExecutionBundle(record, this.signer);
    if (bundle.digest !== ref.bundleDigest || bundle.businessId !== ref.businessId)
      return undefined;

    const definition = bundle.getById(ref.definitionId);
    if (
      definition === undefined ||
      definition.kind !== ref.kind ||
      definition.authoredVersion !== ref.authoredVersion
    ) {
      return undefined;
    }

    return { bundle, definition };
  }
}
