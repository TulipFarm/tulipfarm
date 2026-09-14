import type { OimAuthVerification } from "@tulipfarm/schema";
import { describe, expect, it } from "vitest";
import {
  evaluateOimAuthVerification,
  OimAuthVerificationError,
  type OimVerificationBinding,
  projectVerifiedConnectionIdentity,
} from "./verification-evidence";

const binding: OimVerificationBinding = {
  businessId: "business-1",
  connectionId: "connection-1",
  integrationId: "zendesk",
  integrationMajorVersion: 1,
  packageDigest: "a".repeat(64),
  configurationDigest: "b".repeat(64),
  authSteps: [
    {
      stepId: "credentials",
      revision: 4,
      credentials: [
        {
          slot: "api_token",
          referenceDigest: "c".repeat(64),
        },
      ],
    },
  ],
};

const zendeskVerification: OimAuthVerification = {
  issuer: { source: "configuration_origin", field: "site" },
  checks: [
    {
      id: "current-user",
      operationId: "current-user",
      credentialSlots: ["api_token"],
      success: [
        { kind: "present", path: "/user/id" },
        { kind: "equals", path: "/user/active", value: true },
        { kind: "equals", path: "/user/suspended", value: false },
        { kind: "one_of", path: "/user/role", values: ["agent", "admin"] },
      ],
    },
  ],
  evidence: {
    assurance: "identified",
    subject: {
      kind: "human",
      checkId: "current-user",
      path: "/user/id",
      namespace: "issuer",
    },
  },
};

describe("evaluateOimAuthVerification", () => {
  it("creates identified evidence only after every named check passes", () => {
    const evidence = evaluateOimAuthVerification({
      verification: zendeskVerification,
      configuration: { site: "https://muskan.zendesk.com/path" },
      responses: {
        "current-user": {
          user: { id: 42, active: true, suspended: false, role: "agent" },
        },
      },
      binding,
      verifiedAt: "2026-09-12T12:00:00.000Z",
    });

    expect(evidence).toMatchObject({
      assurance: "identified",
      issuer: "https://muskan.zendesk.com",
      subject: {
        id: "42",
        kind: "human",
        namespace: "https://muskan.zendesk.com",
      },
      tenant: null,
      verifiedBy: "oim-auth-1.1",
      binding,
    });
    expect(evidence.proofDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(projectVerifiedConnectionIdentity(evidence)).toBeNull();
  });

  it("does not invent identity for validity-only evidence", () => {
    const evidence = evaluateOimAuthVerification({
      verification: {
        issuer: { source: "package", value: "https://api.example.com" },
        checks: [
          {
            id: "health",
            operationId: "health",
            credentialSlots: ["api_token"],
            success: [{ kind: "equals", path: "/ok", value: true }],
          },
        ],
        evidence: { assurance: "validity_only" },
      },
      configuration: {},
      responses: { health: { ok: true } },
      binding,
      verifiedAt: "2026-09-12T12:00:00.000Z",
    });

    expect(evidence).toMatchObject({
      assurance: "validity_only",
      issuer: "https://api.example.com",
      subject: null,
      tenant: null,
    });
    expect(projectVerifiedConnectionIdentity(evidence)).toBeNull();
  });

  it("requires both the exact configured Page and its user-token membership", () => {
    const verification: OimAuthVerification = {
      issuer: { source: "package", value: "https://facebook.com" },
      checks: [
        {
          id: "authorized-pages",
          operationId: "list-pages",
          credentialSlots: ["user_token"],
          success: [{ kind: "present", path: "/data" }],
        },
        {
          id: "current-page",
          operationId: "current-page",
          credentialSlots: ["page_token"],
          success: [{ kind: "present", path: "/id" }],
        },
      ],
      comparisons: [
        {
          kind: "equals",
          left: { source: "response", checkId: "current-page", path: "/id" },
          right: { source: "configuration", field: "page_id" },
        },
        {
          kind: "array_contains",
          array: { source: "response", checkId: "authorized-pages", path: "/data" },
          itemPath: "/id",
          value: { source: "configuration", field: "page_id" },
        },
      ],
      evidence: {
        assurance: "identified",
        subject: {
          kind: "account",
          checkId: "current-page",
          path: "/id",
          namespace: "issuer",
        },
        tenant: {
          kind: "account",
          source: "response",
          checkId: "current-page",
          path: "/id",
        },
      },
    };

    const evidence = evaluateOimAuthVerification({
      verification,
      configuration: { page_id: "page-2" },
      responses: {
        "authorized-pages": { data: [{ id: "page-1" }, { id: "page-2" }] },
        "current-page": { id: "page-2" },
      },
      binding,
      verifiedAt: "2026-09-12T12:00:00.000Z",
    });
    expect(projectVerifiedConnectionIdentity(evidence)).toMatchObject({
      externalTenantId: "page-2",
      externalAccountId: "page-2",
      proofDigest: evidence.proofDigest,
    });

    expect(() =>
      evaluateOimAuthVerification({
        verification,
        configuration: { page_id: "page-3" },
        responses: {
          "authorized-pages": { data: [{ id: "page-2" }] },
          "current-page": { id: "page-2" },
        },
        binding,
        verifiedAt: "2026-09-12T12:00:00.000Z",
      })
    ).toThrowError(new OimAuthVerificationError("comparison_failed"));
  });

  it("does not satisfy comparisons with missing values", () => {
    const verification: OimAuthVerification = {
      issuer: { source: "package", value: "https://api.example.com" },
      checks: [
        {
          id: "account",
          operationId: "account",
          credentialSlots: ["api_token"],
          success: [],
        },
        {
          id: "accounts",
          operationId: "accounts",
          credentialSlots: ["api_token"],
          success: [{ kind: "present", path: "/items" }],
        },
      ],
      comparisons: [
        {
          kind: "equals",
          left: { source: "response", checkId: "account", path: "/id" },
          right: { source: "configuration", field: "account_id" },
        },
        {
          kind: "array_contains",
          array: { source: "response", checkId: "accounts", path: "/items" },
          itemPath: "/id",
          value: { source: "configuration", field: "account_id" },
        },
      ],
      evidence: { assurance: "validity_only" },
    };

    expect(() =>
      evaluateOimAuthVerification({
        verification,
        configuration: {},
        responses: { account: {}, accounts: { items: [{}] } },
        binding,
        verifiedAt: "2026-09-12T12:00:00.000Z",
      })
    ).toThrowError(new OimAuthVerificationError("comparison_failed"));
  });

  it("rejects an empty identified subject and binds proof to credential revisions", () => {
    expect(() =>
      evaluateOimAuthVerification({
        verification: {
          ...zendeskVerification,
          checks: [
            {
              ...zendeskVerification.checks[0],
              success: zendeskVerification.checks[0].success.slice(1),
            },
          ],
        },
        configuration: { site: "https://muskan.zendesk.com" },
        responses: {
          "current-user": {
            user: { id: " ", active: true, suspended: false, role: "admin" },
          },
        },
        binding,
        verifiedAt: "2026-09-12T12:00:00.000Z",
      })
    ).toThrowError(new OimAuthVerificationError("subject_missing"));

    const first = evaluateOimAuthVerification({
      verification: {
        ...zendeskVerification,
        evidence: { assurance: "validity_only" },
      },
      configuration: { site: "https://muskan.zendesk.com" },
      responses: {
        "current-user": {
          user: { id: 42, active: true, suspended: false, role: "admin" },
        },
      },
      binding,
      verifiedAt: "2026-09-12T12:00:00.000Z",
    });
    const rotated = evaluateOimAuthVerification({
      verification: {
        ...zendeskVerification,
        evidence: { assurance: "validity_only" },
      },
      configuration: { site: "https://muskan.zendesk.com" },
      responses: {
        "current-user": {
          user: { id: 42, active: true, suspended: false, role: "admin" },
        },
      },
      binding: {
        ...binding,
        authSteps: [{ ...binding.authSteps[0], revision: 5 }],
      },
      verifiedAt: "2026-09-12T12:00:00.000Z",
    });

    expect(rotated.proofDigest).not.toBe(first.proofDigest);
  });

  it("namespaces a subject by the verified client id value, not its Secret reference", () => {
    const verification: OimAuthVerification = {
      ...zendeskVerification,
      evidence: {
        assurance: "identified",
        subject: {
          kind: "human",
          checkId: "current-user",
          path: "/user/id",
          namespace: "issuer_client",
          clientIdSlot: "client_id",
        },
      },
    };
    const input = {
      verification,
      configuration: { site: "https://muskan.zendesk.com" },
      responses: {
        "current-user": {
          user: { id: 42, active: true, suspended: false, role: "agent" },
        },
      },
      verifiedAt: "2026-09-12T12:00:00.000Z",
    } as const;

    expect(() =>
      evaluateOimAuthVerification({
        ...input,
        binding: {
          ...binding,
          authSteps: [
            {
              ...binding.authSteps[0],
              credentials: [
                ...binding.authSteps[0].credentials,
                { slot: "client_id", referenceDigest: "d".repeat(64) },
              ],
            },
          ],
        },
      })
    ).toThrowError(new OimAuthVerificationError("client_binding_missing"));

    const evidence = evaluateOimAuthVerification({
      ...input,
      binding: {
        ...binding,
        authSteps: [
          {
            ...binding.authSteps[0],
            credentials: [
              ...binding.authSteps[0].credentials,
              {
                slot: "client_id",
                referenceDigest: "d".repeat(64),
                valueDigest: "e".repeat(64),
              },
            ],
          },
        ],
      },
    });

    expect(evidence.assurance).toBe("identified");
    if (evidence.assurance !== "identified") throw new Error("expected identified evidence");
    expect(evidence.subject.namespace).toBe(`https://muskan.zendesk.com#client:${"e".repeat(64)}`);
  });
});
