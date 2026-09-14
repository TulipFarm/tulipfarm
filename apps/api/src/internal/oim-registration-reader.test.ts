import { generateKeyPairSync } from "node:crypto";
import { compileOimGraphqlOperations } from "@tulipfarm/integrations";
import { canonicalHash, type OimManifest, oimFileDigest } from "@tulipfarm/schema";
import {
  compileExecutionBundle,
  createEd25519BundleSigner,
  InMemoryBundleStore,
  signExecutionBundle,
  verifierFromSigner,
} from "@tulipfarm/soul";
import { describe, expect, it } from "vitest";
import { BundleRoutineOimRegistrationReader } from "./oim-registration-reader";

const BUSINESS_ID = "business-1";
const DOCUMENT = "query ListTasks { tasks { id title } }\n";
const HOOK_SOURCE = "export function validate() { return { valid: true }; }\n";

function manifest(withHook = false): OimManifest {
  return {
    oimVersion: "1.0",
    kind: "Integration",
    metadata: {
      id: "tasks",
      name: "Tasks",
      version: "1.0.0",
      description: "Read tasks.",
      license: "Apache-2.0",
    },
    profiles: { core: "1.0", ...(withHook ? { hooks: "1.0" as const } : {}) },
    files: [
      {
        path: "operations/list-tasks.graphql",
        role: "graphql",
        sha256: oimFileDigest(DOCUMENT),
      },
      ...(withHook
        ? [
            {
              path: "hooks/validate.mjs",
              role: "hook" as const,
              sha256: oimFileDigest(HOOK_SOURCE),
            },
          ]
        : []),
    ],
    ...(withHook
      ? {
          hooks: [
            {
              kind: "input_validate" as const,
              file: "hooks/validate.mjs",
              export: "validate",
            },
          ],
        }
      : {}),
    operations: [
      {
        id: "list-tasks",
        name: "tasks_list",
        description: "List tasks.",
        effect: "read",
        identityMode: "shared_only",
        source: {
          type: "graphql",
          url: "https://api.tasks.example/graphql",
          operation: "ListTasks",
          documentFile: "operations/list-tasks.graphql",
        },
        requestSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        response: { schema: { type: "object" }, maxBytes: 65_536 },
      },
    ],
  };
}

async function registration(
  storedDocument = DOCUMENT,
  storedHook?: string,
  declareHook = storedHook !== undefined
) {
  const packageManifest = manifest(declareHook);
  const documents = new Map([["operations/list-tasks.graphql", DOCUMENT]]);
  const [compiled] = compileOimGraphqlOperations(
    packageManifest,
    documents,
    {},
    { deferConfiguration: true }
  );
  if (compiled === undefined) throw new Error("expected compiled Tool");

  const bundle = compileExecutionBundle({
    businessId: BUSINESS_ID,
    changesetId: "changeset-1",
    commitSha: "a".repeat(40),
    documents: [compiled.contract],
    files: [
      {
        path: "integrations/tasks/oim.yml",
        content: JSON.stringify(packageManifest),
      },
      {
        path: "integrations/tasks/operations/list-tasks.graphql",
        content: storedDocument,
      },
      ...(storedHook === undefined
        ? []
        : [
            {
              path: "integrations/tasks/hooks/validate.mjs",
              content: storedHook,
            },
          ]),
    ],
  });
  const { privateKey } = generateKeyPairSync("ed25519");
  const signer = createEd25519BundleSigner(
    "test-key",
    privateKey.export({ format: "pem", type: "pkcs8" }).toString()
  );
  const record = signExecutionBundle(bundle, signer);
  const store = new InMemoryBundleStore();
  await store.put(record);
  const contract = bundle.definitions[0];
  if (contract === undefined) throw new Error("expected bundled ToolContract");

  return {
    contract,
    packageManifest,
    reader: new BundleRoutineOimRegistrationReader(store, verifierFromSigner(signer)),
    record,
  };
}

describe("BundleRoutineOimRegistrationReader", () => {
  it("returns the exact signed package that produced a pinned ToolContract", async () => {
    const { contract, packageManifest, reader, record } = await registration();

    await expect(
      reader.find({
        businessId: BUSINESS_ID,
        bundleDigest: record.digest,
        contractId: contract.id,
        contractHash: contract.hash,
      })
    ).resolves.toEqual({
      manifest: packageManifest,
      documents: { "operations/list-tasks.graphql": DOCUMENT },
    });
  });

  it("refuses a lookup whose complete immutable key does not match", async () => {
    const { contract, reader, record } = await registration();

    await expect(
      reader.find({
        businessId: BUSINESS_ID,
        bundleDigest: record.digest,
        contractId: contract.id,
        contractHash: canonicalHash({ wrong: true }),
      })
    ).resolves.toBeUndefined();
    await expect(
      reader.find({
        businessId: "another-business",
        bundleDigest: record.digest,
        contractId: contract.id,
        contractHash: contract.hash,
      })
    ).resolves.toBeUndefined();
  });

  it("refuses a signed bundle whose package bytes do not match its manifest", async () => {
    const { contract, reader, record } = await registration(`${DOCUMENT}\n`);

    await expect(
      reader.find({
        businessId: BUSINESS_ID,
        bundleDigest: record.digest,
        contractId: contract.id,
        contractHash: contract.hash,
      })
    ).resolves.toBeUndefined();
  });

  it("returns only digest-validated declared hook companion bytes", async () => {
    const { contract, packageManifest, reader, record } = await registration(DOCUMENT, HOOK_SOURCE);

    await expect(
      reader.find({
        businessId: BUSINESS_ID,
        bundleDigest: record.digest,
        contractId: contract.id,
        contractHash: contract.hash,
      })
    ).resolves.toEqual({
      manifest: packageManifest,
      documents: { "operations/list-tasks.graphql": DOCUMENT },
      hookFiles: { "hooks/validate.mjs": HOOK_SOURCE },
    });
  });

  it("refuses a signed bundle whose hook bytes do not match the declared digest", async () => {
    const { contract, reader, record } = await registration(
      DOCUMENT,
      `${HOOK_SOURCE}\nexport const changed = true;\n`
    );

    await expect(
      reader.find({
        businessId: BUSINESS_ID,
        bundleDigest: record.digest,
        contractId: contract.id,
        contractHash: contract.hash,
      })
    ).resolves.toBeUndefined();
  });

  it("refuses a signed bundle missing a declared hook companion", async () => {
    const { contract, reader, record } = await registration(DOCUMENT, undefined, true);

    await expect(
      reader.find({
        businessId: BUSINESS_ID,
        bundleDigest: record.digest,
        contractId: contract.id,
        contractHash: contract.hash,
      })
    ).resolves.toBeUndefined();
  });
});
