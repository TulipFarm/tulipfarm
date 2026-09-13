import {
  compileOimGraphqlOperations,
  compileOimHttpOperations,
  compileOimOpenApiOperations,
} from "@tulipfarm/integrations";
import {
  canonicalHash,
  type OimManifest,
  oimPackageIssues,
  parseOimManifest,
} from "@tulipfarm/schema";
import {
  type BundleStore,
  type BundleVerifier,
  type RuntimeBundle,
  verifyExecutionBundle,
} from "@tulipfarm/soul";
import { parse as parseYaml } from "yaml";

export interface RoutineOimRegistrationLookup {
  readonly businessId: string;
  readonly bundleDigest: string;
  readonly contractId: string;
  readonly contractHash: string;
}

export interface RoutineOimRegistration {
  readonly manifest: OimManifest;
  readonly documents?: Readonly<Record<string, string>>;
  readonly openApiDocuments?: Readonly<Record<string, unknown>>;
  readonly hookFiles?: Readonly<Record<string, string>>;
}

function packageFiles(
  bundle: RuntimeBundle,
  ownerDefinitionId: string,
  manifest: OimManifest
): ReadonlyMap<string, string> | undefined {
  const files = new Map<string, string>();
  for (const declared of manifest.files ?? []) {
    const asset = bundle.asset(ownerDefinitionId, declared.path);
    if (asset === undefined) return undefined;
    files.set(declared.path, asset.content);
  }
  return files;
}

function registrationFor(
  manifest: OimManifest,
  files: ReadonlyMap<string, string>,
  contractId: string,
  contractHash: string
): RoutineOimRegistration | undefined {
  if (oimPackageIssues(manifest, files).length > 0) return undefined;

  const documents = Object.fromEntries(
    (manifest.files ?? [])
      .filter((file) => file.role === "graphql")
      .map((file) => [file.path, files.get(file.path)])
      .filter((entry): entry is [string, string] => entry[1] !== undefined)
  );
  const openApiDocuments = Object.fromEntries(
    (manifest.files ?? [])
      .filter((file) => file.role === "openapi")
      .map((file) => [file.path, parseYaml(files.get(file.path) ?? "")])
  );
  const hookFiles = Object.fromEntries(
    [...new Set((manifest.hooks ?? []).map((hook) => hook.file))]
      .map((path) => [path, files.get(path)])
      .filter((entry): entry is [string, string] => entry[1] !== undefined)
  );
  const compiled = [
    ...compileOimHttpOperations(manifest, {}, { deferConfiguration: true }),
    ...compileOimGraphqlOperations(
      manifest,
      new Map(Object.entries(documents)),
      {},
      { deferConfiguration: true }
    ),
    ...compileOimOpenApiOperations(
      manifest,
      new Map(Object.entries(openApiDocuments)),
      {},
      { deferConfiguration: true }
    ),
  ];
  const match = compiled.find(
    ({ contract }) =>
      contract.metadata.id === contractId && canonicalHash(contract) === contractHash
  );
  if (match === undefined) return undefined;

  return {
    manifest,
    ...(Object.keys(documents).length === 0 ? {} : { documents }),
    ...(Object.keys(openApiDocuments).length === 0 ? {} : { openApiDocuments }),
    ...(Object.keys(hookFiles).length === 0 ? {} : { hookFiles }),
  };
}

export class BundleRoutineOimRegistrationReader {
  constructor(
    private readonly bundles: BundleStore,
    private readonly verifier: BundleVerifier
  ) {}

  async find(input: RoutineOimRegistrationLookup): Promise<RoutineOimRegistration | undefined> {
    const record = await this.bundles.get(input.bundleDigest);
    if (record === undefined || record.digest !== input.bundleDigest) return undefined;

    const bundle = verifyExecutionBundle(record, this.verifier);
    if (bundle.businessId !== input.businessId) return undefined;

    const contract = bundle.getById(input.contractId);
    if (
      contract === undefined ||
      contract.kind !== "ToolContract" ||
      contract.hash !== input.contractHash
    ) {
      return undefined;
    }

    const matches: RoutineOimRegistration[] = [];
    for (const asset of bundle.assets) {
      if (asset.path !== "oim.yml") continue;
      try {
        const manifest = parseOimManifest(asset.content);
        const files = packageFiles(bundle, asset.ownerDefinitionId, manifest);
        if (files === undefined) continue;
        const registration = registrationFor(manifest, files, input.contractId, input.contractHash);
        if (registration !== undefined) matches.push(registration);
      } catch {}
    }
    return matches.length === 1 ? matches[0] : undefined;
  }
}
