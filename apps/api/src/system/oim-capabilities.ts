import { OIM_PROFILE_VERSION_MATRIX, type OimOptionalProfile } from "@oim-standard/conformance";
import {
  createRuntimeCapabilityAdvertisement,
  type OimRuntimeCapabilityAdvertisement,
} from "@oim-standard/conformance/capabilities";
import type { OimConformanceReport } from "@oim-standard/conformance/conformance";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ErrorSchema } from "../auth/schemas";
import { runTulipFarmOimConformance } from "../integrations/oim-conformance";
import { runningVersion } from "./version";

type PreHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

export interface OimCapabilitiesRouteDeps {
  readonly runtimeVersion?: string;
  readonly runConformance?: (runtimeVersion: string) => Promise<OimConformanceReport>;
}

export interface OimUnverifiedProfile<Profile extends OimOptionalProfile = OimOptionalProfile> {
  readonly profile: Profile;
  readonly versions: (typeof OIM_PROFILE_VERSION_MATRIX)[Profile];
  readonly reason: "conformance_not_run";
}

export interface OimCapabilitiesResponse {
  readonly capabilities: OimRuntimeCapabilityAdvertisement;
  readonly unverifiedProfiles: readonly OimUnverifiedProfile[];
}

const CapabilityAdvertisementSchema = {
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
    specificationVersions: { type: "array", items: { const: "1.0" } },
    packageEntrypoint: { const: "oim.yml" },
    runtime: {
      type: "object",
      additionalProperties: false,
      required: ["name", "version"],
      properties: {
        name: { type: "string" },
        version: { type: "string" },
      },
    },
    profiles: {
      type: "object",
      additionalProperties: false,
      required: ["core"],
      properties: {
        core: {
          type: "array",
          items: { type: "string", enum: [...OIM_PROFILE_VERSION_MATRIX.core] },
        },
        auth: profileVersionsSchema("auth"),
        events: profileVersionsSchema("events"),
        knowledge: profileVersionsSchema("knowledge"),
        hooks: profileVersionsSchema("hooks"),
      },
    },
    conformance: {
      type: "object",
      additionalProperties: false,
      required: ["suiteVersion", "suiteDigest", "passedCases"],
      properties: {
        suiteVersion: { type: "string" },
        suiteDigest: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" },
        passedCases: { type: "array", items: { type: "string" } },
      },
    },
  },
};

const OimCapabilitiesResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["capabilities", "unverifiedProfiles"],
  properties: {
    capabilities: CapabilityAdvertisementSchema,
    unverifiedProfiles: {
      type: "array",
      items: {
        oneOf: optionalProfiles().map((profile) => ({
          type: "object",
          additionalProperties: false,
          required: ["profile", "versions", "reason"],
          properties: {
            profile: { const: profile },
            versions: profileVersionsSchema(profile),
            reason: { const: "conformance_not_run" },
          },
        })),
      },
    },
  },
};

export function createOimCapabilitiesReader(
  deps: OimCapabilitiesRouteDeps = {}
): () => Promise<OimCapabilitiesResponse> {
  const run = deps.runConformance ?? runTulipFarmOimConformance;
  const runtimeVersion = deps.runtimeVersion ?? runningVersion();
  let cached: Promise<OimCapabilitiesResponse> | undefined;
  return () => {
    cached ??= run(runtimeVersion)
      .then(oimCapabilitiesResponse)
      .catch((error) => {
        cached = undefined;
        throw error;
      });
    return cached;
  };
}

export function registerOimCapabilitiesRoute(
  app: FastifyInstance,
  deps: OimCapabilitiesRouteDeps,
  requireAuth: PreHandler
): void {
  const readCapabilities = createOimCapabilitiesReader(deps);
  app.get(
    "/api/v1/system/oim-capabilities",
    {
      preHandler: requireAuth,
      schema: {
        description:
          "Report OIM profiles verified against this runtime and profiles not yet verified.",
        tags: ["system"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        response: {
          200: OimCapabilitiesResponseSchema,
          401: ErrorSchema,
        },
      },
    },
    readCapabilities
  );
}

export function oimCapabilitiesResponse(report: OimConformanceReport): OimCapabilitiesResponse {
  const capabilities = createRuntimeCapabilityAdvertisement(report);
  const unverifiedProfiles = optionalProfiles().flatMap((profile): OimUnverifiedProfile[] => {
    if (report.claim.profiles[profile] !== undefined) return [];
    return [
      {
        profile,
        versions: OIM_PROFILE_VERSION_MATRIX[profile],
        reason: "conformance_not_run",
      },
    ];
  });
  return { capabilities, unverifiedProfiles };
}

function optionalProfiles(): OimOptionalProfile[] {
  return Object.keys(OIM_PROFILE_VERSION_MATRIX).filter(
    (profile): profile is OimOptionalProfile => profile !== "core"
  );
}

function profileVersionsSchema(profile: keyof typeof OIM_PROFILE_VERSION_MATRIX) {
  return {
    type: "array",
    items: { type: "string", enum: [...OIM_PROFILE_VERSION_MATRIX[profile]] },
  };
}
