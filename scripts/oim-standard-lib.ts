import { spawnSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  OimConformanceClaimSchema,
  OimFixtureSuiteSchema,
  OimManifestSchema,
} from "../packages/schema/src/oim.ts";

const SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema";
const SCHEMA_BASE = "urn:oim:schema:1.0";

function clone<T>(value: T): T {
  return structuredClone(value);
}

function document(id: string, title: string, schema: object): object {
  return {
    $schema: SCHEMA_DIALECT,
    $id: `${SCHEMA_BASE}:${id.replaceAll("/", ":")}`,
    title,
    ...clone(schema),
  };
}

type OimProfile = keyof typeof OimManifestSchema.properties.profiles.properties;

const OPTIONAL_PROFILE_SECTIONS = {
  auth: OimManifestSchema.properties.auth,
  events: OimManifestSchema.properties.events,
  knowledge: OimManifestSchema.properties.knowledge,
  hooks: OimManifestSchema.properties.hooks,
} as const;

function profileVersions(profile: OimProfile): string[] {
  const schema = OimManifestSchema.properties.profiles.properties[profile] as {
    enum?: unknown;
  };
  if (!Array.isArray(schema.enum) || schema.enum.some((version) => typeof version !== "string")) {
    throw new Error(`OIM profile ${profile} has no string version enum`);
  }
  return schema.enum;
}

function coreSchema(version: string): object {
  const schema = clone(OimManifestSchema) as typeof OimManifestSchema;
  schema.properties.profiles.properties.core = {
    type: "string",
    const: version,
  } as never;
  return document(
    `profiles/core-${version}.schema.json`,
    `Open Integration Manifest Core ${version}`,
    schema
  );
}

function profileSchemas(): Array<[string, object]> {
  const core = profileVersions("core").map((version): [string, object] => [
    `profiles/core-${version}.schema.json`,
    coreSchema(version),
  ]);
  const optional = Object.entries(OPTIONAL_PROFILE_SECTIONS).flatMap(([profile, schema]) =>
    profileVersions(profile as keyof typeof OPTIONAL_PROFILE_SECTIONS).map(
      (version): [string, object] => {
        const path = `profiles/${profile}-${version}.schema.json`;
        const name = `${profile[0]?.toUpperCase()}${profile.slice(1)}`;
        return [path, document(path, `Open Integration Manifest ${name} ${version}`, schema)];
      }
    )
  );
  return [...core, ...optional];
}

function capabilityProfileSchemas(): Record<string, object> {
  return Object.fromEntries(
    Object.keys(OimManifestSchema.properties.profiles.properties).map((profile) => [
      profile,
      {
        type: "array",
        minItems: 1,
        uniqueItems: true,
        items: { type: "string", enum: profileVersions(profile as OimProfile) },
      },
    ])
  );
}

export function oimStandardSchemas(): ReadonlyMap<string, object> {
  return new Map([
    [
      "oim.schema.json",
      document("oim.schema.json", "Open Integration Manifest 1.0", OimManifestSchema),
    ],
    [
      "fixture-suite.schema.json",
      document(
        "fixture-suite.schema.json",
        "Open Integration Manifest fixture suite",
        OimFixtureSuiteSchema
      ),
    ],
    [
      "conformance-claim.schema.json",
      document(
        "conformance-claim.schema.json",
        "Open Integration Manifest conformance claim",
        OimConformanceClaimSchema
      ),
    ],
    ...profileSchemas(),
    [
      "conformance-report.schema.json",
      document("conformance-report.schema.json", "Open Integration Manifest conformance report", {
        type: "object",
        additionalProperties: false,
        required: [
          "oimVersion",
          "suiteVersion",
          "suiteDigest",
          "runtime",
          "profiles",
          "results",
          "claim",
        ],
        properties: {
          oimVersion: { const: "1.0" },
          suiteVersion: { type: "string", minLength: 1 },
          suiteDigest: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" },
          runtime: OimConformanceClaimSchema.properties.runtime,
          profiles: OimConformanceClaimSchema.properties.profiles,
          results: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["caseId", "vectorId", "status"],
              properties: {
                caseId: { type: "string", minLength: 1 },
                vectorId: { type: "string", minLength: 1 },
                status: { const: "passed" },
              },
            },
          },
          claim: OimConformanceClaimSchema,
        },
      }),
    ],
    [
      "runtime-capabilities.schema.json",
      document(
        "runtime-capabilities.schema.json",
        "Open Integration Manifest runtime capabilities",
        {
          type: "object",
          additionalProperties: false,
          required: [
            "standard",
            "specificationVersions",
            "packageEntrypoint",
            "runtime",
            "profiles",
            "conformance",
          ],
          properties: {
            standard: { const: "Open Integration Manifest" },
            specificationVersions: {
              type: "array",
              const: ["1.0"],
            },
            packageEntrypoint: { const: "oim.yml" },
            runtime: OimConformanceClaimSchema.properties.runtime,
            profiles: {
              type: "object",
              additionalProperties: false,
              required: ["core"],
              properties: capabilityProfileSchemas(),
            },
            conformance: {
              type: "object",
              additionalProperties: false,
              required: ["suiteVersion", "suiteDigest", "passedCases"],
              properties: {
                suiteVersion: { type: "string", minLength: 1 },
                suiteDigest: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" },
                passedCases: OimConformanceClaimSchema.properties.passedCases,
              },
            },
          },
        }
      ),
    ],
  ]);
}

export function serializeOimStandardSchema(schema: object): string {
  return `${JSON.stringify(schema, null, 2)}\n`;
}

export async function generateOimStandardSchemas(
  root: string,
  outputDirectory: string
): Promise<void> {
  await rm(outputDirectory, { recursive: true, force: true });
  for (const [relativePath, schema] of oimStandardSchemas()) {
    const output = join(outputDirectory, relativePath);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, serializeOimStandardSchema(schema));
  }

  const format = spawnSync("pnpm", ["exec", "biome", "format", "--write", outputDirectory], {
    cwd: root,
    encoding: "utf8",
  });
  if (format.status !== 0) {
    throw new Error(format.stderr || format.stdout || "Biome formatting failed");
  }
}

export async function generateOimStandardRuntime(root: string, output: string): Promise<void> {
  const bundle = spawnSync(
    "pnpm",
    [
      "exec",
      "esbuild",
      "packages/schema/src/oim.ts",
      "--bundle",
      "--packages=external",
      "--platform=node",
      "--format=esm",
      "--target=node22",
      "--alias:ajv/dist/2020=ajv/dist/2020.js",
      "--minify",
      `--outfile=${output}`,
      "--banner:js=/* Generated from packages/schema/src/oim.ts by scripts/oim-standard-generate.ts. */",
      "--legal-comments=eof",
    ],
    { cwd: root, encoding: "utf8" }
  );
  if (bundle.status !== 0) {
    throw new Error(bundle.stderr || bundle.stdout || "esbuild failed");
  }

  const runtime = await readFile(output, "utf8");
  await writeFile(
    output,
    runtime
      .replaceAll(/from\s*"(ajv\/dist\/refs\/[^"]+\.json)";/g, 'from"$1"with{type:"json"};')
      .replaceAll("TulipFarmValidationError", "OimValidationError")
  );
}
