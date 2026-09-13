import {
  canonicalHash,
  type OimAuthVerification,
  type OimConnectionVerificationEvidence,
  type OimVerificationBinding,
} from "@tulipfarm/schema";

export type {
  OimConnectionVerificationEvidence,
  OimVerificationBinding,
  OimVerifiedAuthStepBinding,
  OimVerifiedCredentialBinding,
  OimVerifiedSubject,
  OimVerifiedTenant,
} from "@tulipfarm/schema";

export interface ProjectedConnectionIdentityEvidence {
  readonly externalTenantId: string;
  readonly externalAccountId: string;
  readonly proofDigest: string;
  readonly verifiedAt: string;
  readonly verifiedBy: string;
}

export class OimAuthVerificationError extends Error {
  constructor(
    readonly reason:
      | "check_missing"
      | "predicate_failed"
      | "comparison_failed"
      | "issuer_invalid"
      | "subject_missing"
      | "tenant_missing"
      | "client_binding_missing"
  ) {
    super(reason);
    this.name = "OimAuthVerificationError";
  }
}

interface EvaluateOimAuthVerificationInput {
  readonly verification: OimAuthVerification;
  readonly configuration: Readonly<Record<string, string | number | boolean>>;
  readonly responses: Readonly<Record<string, unknown>>;
  readonly binding: OimVerificationBinding;
  readonly verifiedAt: string;
}

const UNSAFE_POINTER_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);

function pointerValue(value: unknown, pointer: string): unknown {
  let current = value;
  for (const encodedSegment of pointer.slice(1).split("/")) {
    const segment = encodedSegment.replaceAll("~1", "/").replaceAll("~0", "~");
    if (UNSAFE_POINTER_SEGMENTS.has(segment) || typeof current !== "object" || current === null) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function present(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  return !Array.isArray(value) || value.length > 0;
}

function scalarId(value: unknown, reason: "subject_missing" | "tenant_missing"): string {
  if (typeof value !== "string" && typeof value !== "number") {
    throw new OimAuthVerificationError(reason);
  }
  const id = String(value).trim();
  if (id.length === 0) throw new OimAuthVerificationError(reason);
  return id;
}

function response(responses: Readonly<Record<string, unknown>>, checkId: string): unknown {
  if (!(checkId in responses)) throw new OimAuthVerificationError("check_missing");
  return responses[checkId];
}

function referencedValue(
  input: EvaluateOimAuthVerificationInput,
  reference:
    | Extract<NonNullable<OimAuthVerification["comparisons"]>[number], { kind: "equals" }>["left"]
    | Extract<
        NonNullable<OimAuthVerification["comparisons"]>[number],
        { kind: "array_contains" }
      >["value"]
): unknown {
  return reference.source === "configuration"
    ? input.configuration[reference.field]
    : pointerValue(response(input.responses, reference.checkId), reference.path);
}

function issuer(input: EvaluateOimAuthVerificationInput): string {
  const raw =
    input.verification.issuer.source === "package"
      ? input.verification.issuer.value
      : input.configuration[input.verification.issuer.field];
  if (typeof raw !== "string") throw new OimAuthVerificationError("issuer_invalid");
  try {
    const url = new URL(raw);
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      throw new OimAuthVerificationError("issuer_invalid");
    }
    return input.verification.issuer.source === "configuration_origin"
      ? url.origin
      : url.href.replace(/\/$/, "");
  } catch (error) {
    if (error instanceof OimAuthVerificationError) throw error;
    throw new OimAuthVerificationError("issuer_invalid");
  }
}

function normalizeBinding(binding: OimVerificationBinding): OimVerificationBinding {
  return {
    ...binding,
    authSteps: [...binding.authSteps]
      .map((step) => ({
        ...step,
        credentials: [...step.credentials].sort((left, right) =>
          left.slot.localeCompare(right.slot)
        ),
      }))
      .sort((left, right) => left.stepId.localeCompare(right.stepId)),
  };
}

export function evaluateOimAuthVerification(
  input: EvaluateOimAuthVerificationInput
): OimConnectionVerificationEvidence {
  for (const check of input.verification.checks) {
    const output = response(input.responses, check.id);
    for (const predicate of check.success) {
      const value = pointerValue(output, predicate.path);
      const passed =
        predicate.kind === "present"
          ? present(value)
          : predicate.kind === "equals"
            ? value === predicate.value
            : predicate.values.includes(value as string | number | boolean);
      if (!passed) throw new OimAuthVerificationError("predicate_failed");
    }
  }

  for (const comparison of input.verification.comparisons ?? []) {
    if (comparison.kind === "equals") {
      const left = referencedValue(input, comparison.left);
      const right = referencedValue(input, comparison.right);
      if (!present(left) || !present(right) || left !== right) {
        throw new OimAuthVerificationError("comparison_failed");
      }
      continue;
    }
    const array = pointerValue(
      response(input.responses, comparison.array.checkId),
      comparison.array.path
    );
    const expected = referencedValue(input, comparison.value);
    if (
      !Array.isArray(array) ||
      !present(expected) ||
      !array.some((item) => {
        const value = pointerValue(item, comparison.itemPath);
        return present(value) && value === expected;
      })
    ) {
      throw new OimAuthVerificationError("comparison_failed");
    }
  }

  const verifiedIssuer = issuer(input);
  const binding = normalizeBinding(input.binding);
  const proofDigest = canonicalHash({
    verification: input.verification,
    responses: input.responses,
    binding,
    verifiedAt: input.verifiedAt,
  });
  const common = {
    issuer: verifiedIssuer,
    binding,
    proofDigest,
    verifiedAt: input.verifiedAt,
    verifiedBy: "oim-auth-1.1" as const,
  };

  if (input.verification.evidence.assurance === "validity_only") {
    return {
      ...common,
      assurance: "validity_only",
      subject: null,
      tenant: null,
    };
  }

  const declaration = input.verification.evidence;
  const subjectId = scalarId(
    pointerValue(response(input.responses, declaration.subject.checkId), declaration.subject.path),
    "subject_missing"
  );
  let namespace = verifiedIssuer;
  if (declaration.subject.namespace === "issuer_client") {
    const slot = declaration.subject.clientIdSlot;
    const credential = binding.authSteps
      .flatMap((step) => step.credentials)
      .find((candidate) => candidate.slot === slot);
    if (credential?.valueDigest === undefined) {
      throw new OimAuthVerificationError("client_binding_missing");
    }
    namespace = `${verifiedIssuer}#client:${credential.valueDigest}`;
  }
  const tenant =
    declaration.tenant === undefined
      ? null
      : {
          id: scalarId(
            declaration.tenant.source === "configuration"
              ? input.configuration[declaration.tenant.field]
              : declaration.tenant.source === "issuer"
                ? verifiedIssuer
                : pointerValue(
                    response(input.responses, declaration.tenant.checkId),
                    declaration.tenant.path
                  ),
            "tenant_missing"
          ),
          kind: declaration.tenant.kind,
        };
  return {
    ...common,
    assurance: "identified",
    subject: {
      id: subjectId,
      kind: declaration.subject.kind,
      namespace,
    },
    tenant,
  };
}

export function projectVerifiedConnectionIdentity(
  evidence: OimConnectionVerificationEvidence
): ProjectedConnectionIdentityEvidence | null {
  if (evidence.assurance !== "identified" || evidence.tenant === null) return null;
  return {
    externalTenantId: evidence.tenant.id,
    externalAccountId: evidence.subject.id,
    proofDigest: evidence.proofDigest,
    verifiedAt: evidence.verifiedAt,
    verifiedBy: evidence.verifiedBy,
  };
}
