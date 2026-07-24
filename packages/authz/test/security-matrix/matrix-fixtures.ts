import type {
  AccessGrant,
  AccessRequest,
  AuthorityLayer,
  AuthzDecision,
  ExternalIdentityDenialReason,
  ExternalIdentityMapping,
  Guest,
  Principal,
  SessionBinding,
} from "../../src";

export const NOW = new Date("2026-07-24T00:00:00Z");

interface AuthorityMatrixCase {
  readonly dimension: string;
  readonly description: string;
  readonly layers: readonly AuthorityLayer[];
  readonly request: AccessRequest;
  readonly expected: AuthzDecision;
}

const REQUEST: AccessRequest = {
  action: "record.read",
  resourceType: "invoice",
  recordId: "record-sensitive",
  field: "field-sensitive",
  dataClass: "confidential",
  destination: "destination-sensitive",
  conditions: {
    channel: "chat",
    credentialId: "credential-sensitive",
  },
};

const ALLOW_ALL: AccessGrant = {
  action: "*",
  resourceType: "*",
  effect: "allow",
};

function layer(name: string, grants: readonly AccessGrant[] = [ALLOW_ALL]): AuthorityLayer {
  return { name, grants };
}

function layersWith(
  layerName: string,
  grants: readonly AccessGrant[],
  extraLayers: readonly AuthorityLayer[] = []
): readonly AuthorityLayer[] {
  return [
    layer("invoking_user"),
    layer("agent"),
    layer("run_context"),
    layer("tool_target_guardrail"),
    layer("access_grant"),
    layer("credential_scope"),
    ...extraLayers,
  ].map((candidate) => (candidate.name === layerName ? layer(layerName, grants) : candidate));
}

function denied(
  dimension: string,
  description: string,
  deniedLayer: string,
  grants: readonly AccessGrant[],
  request: AccessRequest = REQUEST,
  extraLayers: readonly AuthorityLayer[] = [],
  reason: AuthzDecision["reason"] = "no_matching_allow"
): AuthorityMatrixCase {
  return {
    dimension,
    description,
    layers: layersWith(deniedLayer, grants, extraLayers),
    request,
    expected: { allowed: false, reason, deniedLayer },
  };
}

export const ALLOW_CASE: AuthorityMatrixCase = {
  dimension: "intersection",
  description: "allows only when every authority layer independently allows",
  layers: layersWith("invoking_user", [ALLOW_ALL]),
  request: REQUEST,
  expected: { allowed: true, reason: "allowed" },
};

export const AUTHORITY_MATRIX: readonly AuthorityMatrixCase[] = [
  denied("users", "a user cannot inherit another user's grants", "invoking_user", []),
  denied(
    "Agents",
    "an Agent's explicit deny beats the invoking user's allow",
    "agent",
    [ALLOW_ALL, { ...ALLOW_ALL, effect: "deny" }],
    REQUEST,
    [],
    "explicit_deny"
  ),
  denied("Context", "a Run Context cannot substitute a different channel", "run_context", [
    { ...ALLOW_ALL, conditions: { channel: "web" } },
  ]),
  denied("fields", "a field-scoped grant cannot read a different field", "access_grant", [
    { ...ALLOW_ALL, fieldSelector: ["public-field"] },
  ]),
  denied("records", "a Record grant cannot cross to a different Record", "access_grant", [
    { ...ALLOW_ALL, recordSelector: "other-record" },
  ]),
  denied(
    "destinations",
    "a Guardrail cannot silently change the destination",
    "tool_target_guardrail",
    [{ ...ALLOW_ALL, destination: "internal-only" }]
  ),
  denied(
    "Credentials",
    "a Credential scope cannot be replaced by a broader Credential",
    "credential_scope",
    [{ ...ALLOW_ALL, conditions: { credentialId: "other-credential" } }]
  ),
  denied(
    "delegation",
    "a child Run can narrow but cannot amplify parent authority",
    "child_run",
    [],
    REQUEST,
    [layer("child_run")]
  ),
];

interface SessionSubstitutionCase {
  readonly dimension: string;
  readonly description: string;
  readonly principal: Principal;
  readonly session: SessionBinding;
}

const SESSION: SessionBinding = {
  sid: "session-a",
  principalId: "user-a",
  businessId: "business-a",
  expiresAt: new Date(NOW.getTime() + 60_000),
};

export const SESSION_SUBSTITUTION_MATRIX: readonly SessionSubstitutionCase[] = [
  {
    dimension: "users",
    description: "another user in the same business",
    principal: {
      id: "user-b",
      businessId: "business-a",
      kind: "user",
      status: "active",
    },
    session: SESSION,
  },
  {
    dimension: "Agents",
    description: "an Agent for the invoking user",
    principal: {
      id: "agent-a",
      businessId: "business-a",
      kind: "agent",
      status: "active",
    },
    session: SESSION,
  },
];

interface ExternalIdentityCase {
  readonly description: string;
  readonly mapping: ExternalIdentityMapping | undefined;
  readonly expectedReason: ExternalIdentityDenialReason;
}

const MAPPING: ExternalIdentityMapping = {
  businessId: "business-a",
  provider: "slack",
  externalSubject: "external-user",
  principalId: "user-owner",
  verifiedAt: new Date(NOW.getTime() - 60_000),
};

export const EXTERNAL_IDENTITY_MATRIX: readonly ExternalIdentityCase[] = [
  {
    description: "an unmapped sender",
    mapping: undefined,
    expectedReason: "unmapped",
  },
  {
    description: "a mapped sender substituting for the Conversation owner",
    mapping: { ...MAPPING, principalId: "user-intruder" },
    expectedReason: "substitution",
  },
  {
    description: "a sender mapped to another business",
    mapping: { ...MAPPING, businessId: "business-b" },
    expectedReason: "business_mismatch",
  },
  {
    description: "an expired sender mapping",
    mapping: { ...MAPPING, expiresAt: NOW },
    expectedReason: "expired",
  },
];

const GUEST_GRANT: AccessGrant = {
  action: "record.read",
  resourceType: "invoice",
  effect: "allow",
};

export const REVOCATION_CASE: {
  readonly guest: Guest;
  readonly sponsor: Pick<Principal, "id" | "businessId" | "status" | "expiresAt">;
  readonly request: AccessRequest;
} = {
  guest: {
    principalId: "guest-a",
    businessId: "business-a",
    sponsorPrincipalId: "user-sponsor",
    expiresAt: new Date(NOW.getTime() + 60_000),
    grants: [GUEST_GRANT],
    status: "revoked",
  },
  sponsor: {
    id: "user-sponsor",
    businessId: "business-a",
    status: "active",
  },
  request: {
    action: "record.read",
    resourceType: "invoice",
  },
};
