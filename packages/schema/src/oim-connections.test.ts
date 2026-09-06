import { describe, expect, it } from "vitest";
import { TulipFarmValidationError } from "./error";
import {
  type OimConnection,
  type OimManifest,
  oimCompatibilityIssues,
  oimConnectionIssues,
  oimManifestIssues,
  validateOimConnection,
  validateOimManifest,
} from "./oim";

function manifest(): OimManifest {
  return validateOimManifest({
    oimVersion: "1.0",
    kind: "Integration",
    metadata: {
      id: "weather",
      name: "Weather",
      version: "1.0.0",
      description: "Weather data.",
      license: "Apache-2.0",
    },
    profiles: { core: "1.0", auth: "1.0" },
    auth: {
      credentialSlots: [
        {
          id: "api_key",
          label: "API key",
          kind: "api_key",
        },
      ],
      configurationFields: [
        {
          id: "region",
          label: "Region",
          type: "string",
          agentVisible: true,
        },
      ],
      steps: [
        {
          id: "credentials",
          type: "fields",
          title: "Connect Weather",
          fields: [
            {
              id: "api_key",
              label: "API key",
              input: "password",
              target: { type: "credential", slot: "api_key" },
            },
            {
              id: "region",
              label: "Region",
              input: "text",
              target: { type: "configuration", field: "region" },
            },
          ],
        },
      ],
    },
    operations: [
      {
        id: "current-weather",
        name: "current_weather",
        description: "Read weather.",
        effect: "read",
        identityMode: "shared_or_personal",
        credentialSlot: "api_key",
        credentialInjection: {
          in: "header",
          name: "x-api-key",
          format: "{token}",
        },
        source: {
          type: "http",
          method: "GET",
          baseUrl: "https://api.weather.example",
          path: "/v1/current",
        },
        response: { schema: { type: "object" }, maxBytes: 16_384 },
      },
    ],
  });
}

function connection(): OimConnection {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    integration: { id: "weather", majorVersion: 1 },
    label: "Muskan's Weather",
    owner: {
      scope: "personal",
      principalKind: "user",
      principalId: "00000000-0000-4000-8000-000000000002",
    },
    status: "active",
    isDefault: true,
    configuration: { region: "us-east" },
    agentVisibleConfiguration: ["region"],
    secretBindings: {
      api_key: "secret://00000000-0000-4000-8000-000000000003",
    },
    health: { status: "unknown", checkedAt: null },
    expiresAt: null,
  };
}

describe("OIM Auth profile", () => {
  it("accepts declarative credential slots, safe configuration, and secure field setup", () => {
    expect(oimManifestIssues(manifest())).toEqual([]);
  });

  it("requires the Auth profile and declared credential slots", () => {
    const missingProfile = manifest();
    delete missingProfile.profiles.auth;
    expect(oimManifestIssues(missingProfile)).toContain(
      'profiles: auth "1.0" is required when auth is declared'
    );

    const unknownSlot = manifest();
    unknownSlot.operations[0].credentialSlot = "missing";
    expect(oimManifestIssues(unknownSlot)).toContain(
      "operations: current-weather references undeclared credential slot missing"
    );
  });

  it("requires one explicit native HTTP credential injection rule", () => {
    const missing = manifest();
    delete missing.operations[0].credentialInjection;
    expect(oimManifestIssues(missing)).toContain(
      "operations: current-weather credential injection is required for native HTTP"
    );

    const malformed = manifest();
    if (!malformed.operations[0].credentialInjection) {
      throw new Error("expected credential injection");
    }
    malformed.operations[0].credentialInjection.format = "Bearer token";
    expect(oimManifestIssues(malformed)).toContain(
      "operations: current-weather credential injection format must contain one {token}"
    );
  });

  it("never permits a password field to enter safe configuration", () => {
    const invalid = manifest();
    if (invalid.auth?.steps[0]?.type !== "fields") {
      throw new Error("expected fields step");
    }
    invalid.auth.steps[0].fields[0] = {
      id: "region",
      label: "Region password",
      input: "password",
      target: { type: "configuration", field: "region" },
    };

    expect(oimManifestIssues(invalid)).toContain(
      "auth: step credentials password field region must target a credential slot"
    );
  });

  it("keeps credential and visible configuration contracts stable within one major", () => {
    const previous = manifest();
    const next = structuredClone(previous);
    next.metadata.version = "1.1.0";
    if (!next.auth) throw new Error("expected Auth profile");
    next.auth.credentialSlots = [];
    next.auth.configurationFields = [];

    expect(oimCompatibilityIssues(previous, next)).toEqual([
      "auth: credential slot api_key was removed",
      "auth: configuration field region was removed",
    ]);
  });

  it("rejects new required auth inputs and changed secure field mappings within one major", () => {
    const previous = manifest();
    const next = structuredClone(previous);
    next.metadata.version = "1.1.0";
    if (next.auth?.steps[0]?.type !== "fields") {
      throw new Error("expected fields step");
    }
    next.auth.credentialSlots.push({
      id: "admin_token",
      label: "Admin token",
      kind: "bearer_token",
    });
    next.auth.configurationFields?.push({
      id: "tenant",
      label: "Tenant",
      type: "string",
      required: true,
    });
    next.auth.steps[0].fields[0].target = {
      type: "credential",
      slot: "admin_token",
    };

    expect(oimCompatibilityIssues(previous, next)).toEqual(
      expect.arrayContaining([
        "auth: added required credential slot admin_token",
        "auth: added required configuration field tenant",
        "auth: step credentials changed credential mapping",
      ])
    );
  });

  it("rejects required Auth added to an unauthenticated Integration within one major", () => {
    const previous = manifest();
    delete previous.auth;
    delete previous.profiles.auth;
    delete previous.operations[0].credentialSlot;

    const next = manifest();
    next.metadata.version = "1.1.0";
    if (!next.auth?.configurationFields?.[0]) throw new Error("expected configuration field");
    next.auth.configurationFields[0].required = true;

    expect(oimCompatibilityIssues(previous, next)).toEqual(
      expect.arrayContaining([
        "auth: added required credential slot api_key",
        "auth: added required configuration field region",
      ])
    );
  });
});

describe("OIM Connection contract", () => {
  it("accepts a personal Connection with safe configuration and opaque Secret references", () => {
    expect(validateOimConnection(connection())).toEqual(connection());
    expect(oimConnectionIssues(connection(), manifest())).toEqual([]);
  });

  it("accepts a Team Connection only with a canonical Team id", () => {
    const teamConnection = {
      ...connection(),
      owner: { scope: "team" as const, teamId: "00000000-0000-4000-8000-000000000004" },
    };
    expect(validateOimConnection(teamConnection)).toEqual(teamConnection);
    expect(() =>
      validateOimConnection({
        ...teamConnection,
        owner: { scope: "team", teamId: "team-support" },
      })
    ).toThrow(TulipFarmValidationError);
  });

  it("rejects plaintext credentials and personal ownership by non-users", () => {
    expect(() =>
      validateOimConnection({
        ...connection(),
        secretBindings: { api_key: "plaintext-key" },
      })
    ).toThrow(TulipFarmValidationError);
    expect(() =>
      validateOimConnection({
        ...connection(),
        secretBindings: { api_key: "secret://constructor" },
      })
    ).toThrow(TulipFarmValidationError);

    expect(() =>
      validateOimConnection({
        ...connection(),
        owner: {
          scope: "personal",
          principalKind: "agent",
          principalId: "00000000-0000-4000-8000-000000000002",
        },
      })
    ).toThrow(TulipFarmValidationError);
  });

  it("requires bindings and visible configuration keys to exist in the manifest", () => {
    const invalid = connection();
    invalid.secretBindings = {
      api_key: invalid.secretBindings.api_key,
      admin_token: "secret://00000000-0000-4000-8000-000000000004",
    };
    invalid.agentVisibleConfiguration = ["tenant"];

    expect(oimConnectionIssues(invalid, manifest())).toEqual([
      "secretBindings: admin_token is not declared by the Integration",
      "agentVisibleConfiguration: tenant is not declared agent-visible by the Integration",
    ]);
  });
});
