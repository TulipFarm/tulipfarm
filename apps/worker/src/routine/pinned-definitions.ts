import {
  type BundleStore,
  createEd25519BundleVerifier,
  type PinnedDefinition,
  PinnedDefinitionLoader,
  type PinnedDefinitionRef,
  SOUL_BUNDLE_PUBLIC_KEY,
  SOUL_BUNDLE_SIGNING_KEY_ID,
} from "@tulipfarm/soul";

export interface WorkerSecretReader {
  get(key: string): Promise<string>;
}

/**
 * Lazily opens the exact signed bundle a Run pinned.
 *
 * Worker boot must not provision signing material and a replica with no Routine work should not
 * need it. The first Routine load therefore reads the API-provisioned public key, builds one
 * verifying loader, and reuses it. There is deliberately no private key, `set`, or
 * active-publication port here.
 */
export class WorkerPinnedDefinitionReader {
  private loader: Promise<PinnedDefinitionLoader> | undefined;

  constructor(
    private readonly bundles: BundleStore,
    private readonly secrets: () => Promise<WorkerSecretReader>
  ) {}

  load(ref: PinnedDefinitionRef): Promise<PinnedDefinition | undefined> {
    return this.resolveLoader().then((loader) => loader.load(ref));
  }

  private resolveLoader(): Promise<PinnedDefinitionLoader> {
    this.loader ??= this.secrets().then(async (secrets) => {
      const publicKeyPem = await secrets.get(SOUL_BUNDLE_PUBLIC_KEY);
      return new PinnedDefinitionLoader(
        this.bundles,
        createEd25519BundleVerifier([{ keyId: SOUL_BUNDLE_SIGNING_KEY_ID, publicKeyPem }])
      );
    });
    return this.loader;
  }
}
