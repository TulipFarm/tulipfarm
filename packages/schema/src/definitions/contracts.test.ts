import { describe, expect, it } from "vitest";
import { SchemaRegistry, SchemaValidationError } from "../index";
import { PRINCIPAL_KINDS } from "../principals";
import { FormActionDescriptorSchema, FormSchema } from "./form";
import { GuardrailSchema } from "./guardrail";
import {
  AccessGrantSchema,
  AppSchema,
  IntegrationAdapterSchema,
  IntegrationSchema,
} from "./integration";
import * as knowledgeContracts from "./knowledge";
import { KnowledgeCaptureSchema, KnowledgeSourceSchema } from "./knowledge";
import { MemorySettingsSchema } from "./memory";
import { RoleSchema } from "./role";
import { SettingsSchema } from "./settings";

const apiVersion = "tulipfarm.ai/v1";
const definitionId = "018f3f8a-7b5c-7c9d-8e1f-2a3b4c5d6e7f";
const digest = "a".repeat(64);
const expiresAt = "2026-07-23T10:30:00Z";
const approvalCategories = {
  soulChange: true,
  highRiskAction: true,
  destructiveAction: true,
  protectedDataEgress: true,
  credentialUse: true,
};

const metadata = (slug: string) => ({
  id: definitionId,
  slug,
  schemaVersion: 1,
  authoredVersion: 1,
  lifecycle: "draft",
});

const registrations = [
  { apiVersion, kind: "Role", schema: RoleSchema },
  { apiVersion, kind: "Guardrail", schema: GuardrailSchema },
  { apiVersion, kind: "Settings", schema: SettingsSchema },
  { apiVersion, kind: "IntegrationAdapter", schema: IntegrationAdapterSchema },
  { apiVersion, kind: "App", schema: AppSchema },
  { apiVersion, kind: "Integration", schema: IntegrationSchema },
  { apiVersion, kind: "AccessGrant", schema: AccessGrantSchema },
  { apiVersion, kind: "KnowledgeSource", schema: KnowledgeSourceSchema },
  { apiVersion, kind: "KnowledgeCapture", schema: KnowledgeCaptureSchema },
  { apiVersion, kind: "MemorySettings", schema: MemorySettingsSchema },
  { apiVersion, kind: "Form", schema: FormSchema },
  { apiVersion, kind: "FormActionDescriptor", schema: FormActionDescriptorSchema },
] as const;

function registry(): SchemaRegistry {
  return new SchemaRegistry(registrations);
}

const validationRegistry = registry();

function expectInvalid(document: unknown): void {
  expect(() => validationRegistry.validate(document)).toThrow(SchemaValidationError);
}

function expectInvalidAt(document: unknown, path: string, keyword: string): void {
  try {
    validationRegistry.validate(document);
    throw new Error("expected validation to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(SchemaValidationError);
    const validationError = error as SchemaValidationError;
    expect(validationError.code).toBe("SCHEMA_VALIDATION_FAILED");
    expect(validationError.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ path, keyword })])
    );
  }
}

function expectInvalidRequired(document: unknown, field: string): void {
  try {
    validationRegistry.validate(document);
    throw new Error("expected validation to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(SchemaValidationError);
    const validationError = error as SchemaValidationError;
    expect(validationError.code).toBe("SCHEMA_VALIDATION_FAILED");
    expect(validationError.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "",
          keyword: "required",
          message: `must have required property '${field}'`,
        }),
      ])
    );
  }
}

describe("authored definition schemas", () => {
  it("does not register runtime Knowledge capture evidence as an authored definition", () => {
    expect(knowledgeContracts).not.toHaveProperty("KNOWLEDGE_CAPTURE_DEFINITION");
  });

  it("validates every owned kind deterministically across registry restarts", () => {
    const documents = [
      {
        apiVersion,
        kind: "Role",
        metadata: metadata("support-operator"),
        spec: {
          principalTypes: [...PRINCIPAL_KINDS],
          grants: [
            {
              effect: "allow",
              actions: ["ticket.read"],
              resource: { types: ["ticket"], recordIds: ["ticket-42"] },
              fields: ["title", "status"],
              domains: ["support"],
              conditions: [{ attribute: "context.channel", operator: "equals", value: "support" }],
              delegable: false,
            },
          ],
        },
      },
      {
        apiVersion,
        kind: "Guardrail",
        metadata: metadata("protected-data"),
        spec: {
          defaultDecision: "deny",
          rules: [
            {
              id: "block-secret-egress",
              type: "dlp",
              detectors: [{ type: "secret" }],
              action: "block",
              destinations: ["external"],
              scope: {
                resource: {
                  types: ["ticket"],
                  recordIds: ["ticket-42"],
                  fields: ["description"],
                },
                conditions: [
                  { attribute: "context.channel", operator: "equals", value: "support" },
                ],
                expiresAt,
              },
              constraints: {
                maxRecords: 10,
                maxBytes: 1048576,
                maxCostUsd: 2.5,
                timeWindow: { startsAt: "2026-07-22T10:30:00Z", expiresAt },
                network: { allowedHosts: ["api.example.com"], allowPrivateNetworks: false },
                executionEnvironments: ["managedAdapter"],
              },
            },
            {
              id: "approve-destructive",
              type: "approval",
              actions: ["record.delete"],
              category: "destructiveAction",
              minimumApprovers: 2,
              separationOfDuties: true,
            },
          ],
        },
      },
      {
        apiVersion,
        kind: "Settings",
        metadata: metadata("business-settings"),
        spec: {
          approvalCategories: {
            ...approvalCategories,
            protectedDataEgress: false,
          },
        },
      },
      {
        apiVersion,
        kind: "IntegrationAdapter",
        metadata: metadata("slack"),
        spec: {
          provider: "slack",
          execution: { mode: "managed", adapter: "slack" },
          authTypes: ["oauth2", "token"],
          operations: ["message.read", "message.send"],
          events: ["message.created"],
        },
      },
      {
        apiVersion,
        kind: "App",
        metadata: metadata("support-slack-app"),
        spec: {
          adapterId: definitionId,
          externalAppId: "A012345",
          credentialRefs: ["secret://credentials/slack/support-app"],
        },
      },
      {
        apiVersion,
        kind: "Integration",
        metadata: metadata("support-workspace"),
        spec: {
          appId: definitionId,
          externalAccount: { tenantId: "T012345", accountId: "workspace-support" },
          credentialRef: "secret://credentials/slack/support-workspace",
        },
      },
      {
        apiVersion,
        kind: "AccessGrant",
        metadata: metadata("support-channels"),
        spec: {
          integrationId: definitionId,
          principals: [{ kind: "role", id: definitionId }],
          actions: ["message.read", "message.send"],
          externalTargets: [{ type: "channel", ids: ["C012345"] }],
          delegable: false,
        },
      },
      {
        apiVersion,
        kind: "KnowledgeSource",
        metadata: metadata("support-handbook"),
        spec: {
          integrationId: definitionId,
          source: {
            provider: "google-drive",
            externalId: "drive-42",
            externalTenantId: "tenant-42",
            ownerExternalId: "owner-42",
          },
          accessControl: { mode: "live", maximumAgeSeconds: 300 },
          classification: ["internal"],
        },
      },
      {
        apiVersion,
        kind: "KnowledgeCapture",
        knowledgeSourceId: definitionId,
        sourceRevision: "revision-7",
        capturedAt: "2026-07-22T10:30:00Z",
        contentHash: digest,
        aclRevision: "acl-revision-3",
      },
      {
        apiVersion,
        kind: "MemorySettings",
        metadata: metadata("business-memory"),
        spec: {
          scopes: ["user_private", "user_agent", "run_local"],
          inferredDurableMemory: { enabled: true, confirmationRequired: true },
          defaultExpiryDays: 90,
        },
      },
      {
        apiVersion,
        kind: "Form",
        metadata: metadata("incident-intake"),
        spec: {
          title: "Incident intake",
          submission: { triggerId: definitionId, inputName: "incident" },
          audience: { roleIds: [definitionId] },
          fields: [
            { name: "summary", label: "Summary", input: "text", required: true },
            { name: "severity", label: "Severity", input: "select", options: ["low", "high"] },
          ],
        },
      },
      {
        apiVersion,
        kind: "FormActionDescriptor",
        formId: definitionId,
        runId: definitionId,
        runWaitId: definitionId,
        schemaDigest: digest,
        audience: { kind: "user", id: definitionId },
        resumeToken: "abcdefghijklmnopqrstuvwxyzABCDEFG123456",
        nonce: "nonce-abcdefghijklmnopqrstuvwxyz123456",
        expiresAt,
      },
    ];

    const firstRegistry = registry();
    const restartedRegistry = registry();

    for (const document of documents) {
      const first = firstRegistry.validate(document);
      const restarted = restartedRegistry.validate(JSON.parse(JSON.stringify(document)));
      expect(first.hash).toBe(restarted.hash);
    }
  });

  it("accepts provider-qualified external target types on an AccessGrant", () => {
    const grant = {
      apiVersion,
      kind: "AccessGrant",
      metadata: metadata("triage-repository"),
      spec: {
        integrationId: definitionId,
        principals: [{ kind: "role", id: definitionId }],
        actions: ["github.issue.read", "github.issue.label"],
        externalTargets: [
          { type: "github.repository", ids: ["tulip/farm"] },
          { type: "jira.project", ids: ["ENG"] },
          { type: "channel", ids: ["C012345"] },
        ],
        delegable: false,
      },
    };

    expect(() => validationRegistry.validate(grant)).not.toThrow();
  });

  it("still rejects an external target type that is not a qualified slug", () => {
    const grant = {
      apiVersion,
      kind: "AccessGrant",
      metadata: metadata("malformed-target"),
      spec: {
        integrationId: definitionId,
        principals: [{ kind: "role", id: definitionId }],
        actions: ["github.issue.read"],
        externalTargets: [{ type: "GitHub Repository", ids: ["tulip/farm"] }],
        delegable: false,
      },
    };

    expectInvalidAt(grant, "/spec/externalTargets/0/type", "pattern");
  });

  it("rejects both unbounded authority and grants that would match nothing", () => {
    // Two rules pulling opposite ways — see `role.ts`. Unbounded authority (`*` on actions or
    // types) is refused so authored roles enumerate and least privilege is the default. Dead forms
    // (`record.*`, `fields: ["*"]`) are refused because `grantMatches` compares them literally, so
    // they would match no request at all and silently deny every call under default-deny. Both
    // fail loudly at authoring time, which is the point.
    function roleGranting(grant: Record<string, unknown>): unknown {
      return {
        apiVersion,
        kind: "Role",
        metadata: metadata("scoped-role"),
        spec: {
          principalTypes: ["agent"],
          grants: [
            {
              effect: "allow",
              actions: ["ticket.read"],
              resource: { types: ["ticket"] },
              delegable: false,
              ...grant,
            },
          ],
        },
      };
    }

    // Unbounded: an authored Role must not express blanket authority.
    expectInvalidAt(roleGranting({ actions: ["*"] }), "/spec/grants/0/actions/0", "pattern");
    // Omitting `resource` entirely used to be the quiet door to the same thing: the compiler
    // substituted `["*"]`, producing a grant row byte-identical to the one the pattern below
    // refuses. A grant must name what it is over.
    expectInvalidAt(
      {
        apiVersion,
        kind: "Role",
        metadata: metadata("resourceless-role"),
        spec: {
          principalTypes: ["agent"],
          grants: [{ effect: "allow", actions: ["ticket.read"], delegable: false }],
        },
      },
      "/spec/grants/0",
      "required"
    );
    expectInvalidAt(
      roleGranting({ resource: { types: ["*"] } }),
      "/spec/grants/0/resource/types/0",
      "pattern"
    );

    // Dead: compared literally by the matcher, so these would match nothing.
    for (const dead of ["record.*", "tool.*", "*.employee"]) {
      expectInvalidAt(
        roleGranting({ resource: { types: [dead] } }),
        "/spec/grants/0/resource/types/0",
        "pattern"
      );
    }
    expectInvalidAt(roleGranting({ fields: ["*"] }), "/spec/grants/0/fields/0", "pattern");
    expectInvalidAt(
      roleGranting({ destinations: ["*"] }),
      "/spec/grants/0/destinations/0",
      "pattern"
    );
    expectInvalidAt(
      roleGranting({ dataClasses: ["*"] }),
      "/spec/grants/0/dataClasses/0",
      "pattern"
    );

    // Honoured by the matcher, or the ordinary way to say "covers anything": still authorable.
    for (const valid of [
      { resource: { types: ["record.employee"] } },
      { resource: { types: ["ticket"], recordIds: ["*"] } },
      { domains: ["*"] },
      { fields: ["title"] },
    ]) {
      expect(() => validationRegistry.validate(roleGranting(valid))).not.toThrow();
    }
  });

  it("rejects wildcard authority and unknown grant properties", () => {
    const base = {
      apiVersion,
      kind: "Role",
      metadata: metadata("overpowered-role"),
      spec: {
        principalTypes: ["agent"],
        grants: [{ effect: "allow", actions: ["*"], delegable: false }],
      },
    };

    expectInvalidAt(base, "/spec/grants/0/actions/0", "pattern");
    expectInvalidAt(
      {
        ...base,
        spec: {
          principalTypes: ["agent"],
          grants: [
            {
              effect: "allow",
              actions: ["ticket.read"],
              delegable: false,
              permissionCeiling: "all",
            },
          ],
        },
      },
      "/spec/grants/0",
      "additionalProperties"
    );
  });

  it("accepts the named-domain wildcard sentinel on Role grants", () => {
    expect(() =>
      validationRegistry.validate({
        apiVersion,
        kind: "Role",
        metadata: metadata("domain-wildcard"),
        spec: {
          principalTypes: ["user"],
          grants: [
            {
              effect: "allow",
              actions: ["ticket.read"],
              resource: { types: ["ticket"] },
              domains: ["*"],
              delegable: false,
            },
          ],
        },
      })
    ).not.toThrow();
  });

  it("requires explicit independent approval categories instead of a global bypass", () => {
    expectInvalidAt(
      {
        apiVersion,
        kind: "Settings",
        metadata: metadata("unsafe-settings"),
        spec: { approvalCategories, approvalsEnabled: false },
      },
      "/spec",
      "additionalProperties"
    );
    expectInvalid({
      apiVersion,
      kind: "Settings",
      metadata: metadata("incomplete-settings"),
      spec: {
        approvalCategories: {
          soulChange: true,
          highRiskAction: true,
          destructiveAction: true,
          protectedDataEgress: true,
        },
      },
    });
  });

  it("keeps App and Agent identity separate and accepts only opaque Credential references", () => {
    expectInvalidAt(
      {
        apiVersion,
        kind: "App",
        metadata: metadata("conflated-app"),
        spec: {
          adapterId: definitionId,
          externalAppId: "A012345",
          credentialRefs: [],
          agentId: definitionId,
        },
      },
      "/spec",
      "additionalProperties"
    );
    expectInvalid({
      apiVersion,
      kind: "Integration",
      metadata: metadata("plaintext-integration"),
      spec: {
        appId: definitionId,
        externalAccount: { tenantId: "tenant" },
        credentialRef: "xoxb-plaintext-token",
      },
    });
    expectInvalid({
      apiVersion,
      kind: "IntegrationAdapter",
      metadata: metadata("in-process-adapter"),
      spec: {
        provider: "custom",
        execution: { mode: "command", command: "node untrusted.js" },
        authTypes: ["none"],
        operations: ["data.read"],
        events: [],
      },
    });
  });

  it("rejects unverifiable Knowledge access and inferred Memory without confirmation", () => {
    expectInvalid({
      apiVersion,
      kind: "KnowledgeSource",
      metadata: metadata("unverifiable-source"),
      spec: {
        integrationId: definitionId,
        source: {
          provider: "drive",
          externalId: "private",
          externalTenantId: "tenant",
          ownerExternalId: "owner",
        },
        accessControl: { mode: "unverified" },
        classification: ["confidential"],
      },
    });
    expectInvalid({
      apiVersion,
      kind: "MemorySettings",
      metadata: metadata("unsafe-memory"),
      spec: {
        scopes: ["business"],
        inferredDurableMemory: { enabled: true, confirmationRequired: false },
      },
    });
  });

  it("rejects plaintext secret form fields", () => {
    expectInvalid({
      apiVersion,
      kind: "Form",
      metadata: metadata("secret-form"),
      spec: {
        title: "Credentials",
        submission: { triggerId: definitionId, inputName: "credentials" },
        audience: { roleIds: [definitionId] },
        fields: [{ name: "apiKey", label: "API key", input: "secret" }],
      },
    });
  });

  it("rejects direct Form-to-Routine dispatch and incomplete resume descriptors", () => {
    expectInvalidAt(
      {
        apiVersion,
        kind: "Form",
        metadata: metadata("direct-routine-form"),
        spec: {
          title: "Unsafe direct dispatch",
          submission: { routineId: definitionId, inputName: "payload" },
          audience: { roleIds: [definitionId] },
          fields: [{ name: "summary", label: "Summary", input: "text" }],
        },
      },
      "/spec/submission",
      "additionalProperties"
    );
    expectInvalidAt(
      {
        apiVersion,
        kind: "FormActionDescriptor",
        formId: definitionId,
        runId: definitionId,
        runWaitId: definitionId,
        schemaDigest: digest,
        audience: { kind: "user", id: definitionId },
        resumeToken: "short",
        nonce: "nonce-abcdefghijklmnopqrstuvwxyz123456",
        expiresAt,
      },
      "/resumeToken",
      "minLength"
    );

    const descriptor: Record<string, unknown> = {
      apiVersion,
      kind: "FormActionDescriptor",
      formId: definitionId,
      runId: definitionId,
      runWaitId: definitionId,
      schemaDigest: digest,
      audience: { kind: "user", id: definitionId },
      resumeToken: "abcdefghijklmnopqrstuvwxyzABCDEFG123456",
      nonce: "nonce-abcdefghijklmnopqrstuvwxyz123456",
      expiresAt,
    };
    for (const field of [
      "formId",
      "runId",
      "runWaitId",
      "schemaDigest",
      "audience",
      "resumeToken",
      "nonce",
      "expiresAt",
    ]) {
      const incomplete = { ...descriptor };
      delete incomplete[field];
      expectInvalidRequired(incomplete, field);
    }
  });

  it("rejects unsafe Guardrail constraints without accepting free-form expressions", () => {
    const guardrail = (constraints: Record<string, unknown>, scope: Record<string, unknown>) => ({
      apiVersion,
      kind: "Guardrail",
      metadata: metadata("unsafe-constraints"),
      spec: {
        defaultDecision: "deny",
        rules: [
          {
            id: "constrained-read",
            type: "allow",
            actions: ["ticket.read"],
            scope,
            constraints,
          },
        ],
      },
    });

    expectInvalid(guardrail({ maxRecords: 0 }, {}));
    expectInvalid(
      guardrail({ network: { allowedHosts: ["api.example.com"], allowPrivateNetworks: true } }, {})
    );
    expectInvalid(guardrail({ executionEnvironments: ["localProcess"] }, {}));
    expectInvalid(guardrail({}, { expiresAt: "tomorrow" }));
    expectInvalid(guardrail({}, { conditionExpression: "actor.isAdmin || true" }));
    expectInvalidAt(
      {
        ...guardrail({}, { resource: { types: ["ticket"] } }),
        spec: {
          defaultDecision: "deny",
          rules: [
            {
              id: "contradictory-resource-scope",
              type: "allow",
              actions: ["ticket.read"],
              resourceTypes: ["invoice"],
              scope: { resource: { types: ["ticket"] } },
            },
          ],
        },
      },
      "/spec/rules/0",
      "additionalProperties"
    );
  });

  it("rejects traversal-shaped Secret refs, malformed HTTPS endpoints, and invalid expiries", () => {
    expectInvalid({
      apiVersion,
      kind: "Integration",
      metadata: metadata("traversal-secret"),
      spec: {
        appId: definitionId,
        externalAccount: { tenantId: "tenant" },
        credentialRef: "secret://credentials/../../admin",
      },
    });
    expectInvalid({
      apiVersion,
      kind: "IntegrationAdapter",
      metadata: metadata("malformed-endpoint"),
      spec: {
        provider: "custom",
        execution: { mode: "externalProtocol", endpoint: "https://", protocolVersion: 1 },
        authTypes: ["none"],
        operations: ["data.read"],
        events: [],
      },
    });
    expectInvalid({
      apiVersion,
      kind: "Role",
      metadata: metadata("invalid-expiry"),
      spec: {
        principalTypes: ["user"],
        grants: [
          { effect: "allow", actions: ["ticket.read"], expiresAt: "tomorrow", delegable: false },
        ],
      },
    });
  });

  it("keeps mutable Knowledge capture evidence out of authored source definitions", () => {
    expectInvalidRequired(
      {
        apiVersion,
        kind: "KnowledgeCapture",
        knowledgeSourceId: definitionId,
        capturedAt: "2026-07-22T10:30:00Z",
        contentHash: digest,
        aclRevision: "acl-revision-3",
      },
      "sourceRevision"
    );
  });

  it("does not echo protected values in structured validation errors", () => {
    const protectedValue = "xoxb-do-not-disclose";

    try {
      validationRegistry.validate({
        apiVersion,
        kind: "Integration",
        metadata: metadata("redacted-error"),
        spec: {
          appId: definitionId,
          externalAccount: { tenantId: "tenant" },
          credentialRef: protectedValue,
        },
      });
      throw new Error("expected validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(SchemaValidationError);
      expect((error as Error).message).not.toContain(protectedValue);
    }
  });
});
