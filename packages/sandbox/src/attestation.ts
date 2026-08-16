import type { SandboxIsolation } from "./ports/sandbox";
import {
  type SandboxSignature,
  type SandboxSignatureSigner,
  type SandboxSignatureVerifier,
  signSandboxPayload,
  verifySandboxPayload,
} from "./signature";
import { SandboxProtocolError } from "./wire";

/**
 * Backend-produced evidence bound to a fresh request challenge. Capability flags describe
 * enforced properties, not optional features.
 */
export interface SandboxBackendAttestation {
  readonly attestationId: string;
  readonly backendId: string;
  readonly provider: string;
  readonly isolation: SandboxIsolation;
  /** Provider measurement or immutable image digest verified by the attestation trust root. */
  readonly measurement: string;
  readonly challenge: string;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
  readonly capabilities: {
    readonly ephemeralWorkspace: boolean;
    readonly computeLimits: boolean;
    readonly egressAllowlist: boolean;
    readonly credentialInjection: boolean;
    readonly hostMounts: boolean;
    readonly directBusinessMutation: boolean;
  };
}

export interface SignedSandboxBackendAttestation {
  readonly body: SandboxBackendAttestation;
  readonly signature: SandboxSignature;
}

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SandboxProtocolError("invalid_attestation");
  }
  return value as UnknownRecord;
}

function exactKeys(value: UnknownRecord, keys: readonly string[]): void {
  const allowed = new Set(keys);
  if (Object.keys(value).some((key) => !allowed.has(key)) || keys.some((key) => !(key in value))) {
    throw new SandboxProtocolError("invalid_attestation");
  }
}

function string(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) {
    throw new SandboxProtocolError("invalid_attestation");
  }
  return value;
}

function integer(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new SandboxProtocolError("invalid_attestation");
  }
  return value as number;
}

function boolean(value: unknown): boolean {
  if (typeof value !== "boolean") {
    throw new SandboxProtocolError("invalid_attestation");
  }
  return value;
}

const ISOLATIONS = new Set<SandboxIsolation>([
  "microvm",
  "remote-managed",
  "container",
  "local",
  "ssh",
]);

function parseSandboxBackendAttestation(input: unknown): SandboxBackendAttestation {
  const body = record(input);
  exactKeys(body, [
    "attestationId",
    "backendId",
    "provider",
    "isolation",
    "measurement",
    "challenge",
    "issuedAtMs",
    "expiresAtMs",
    "capabilities",
  ]);
  if (typeof body.isolation !== "string" || !ISOLATIONS.has(body.isolation as SandboxIsolation)) {
    throw new SandboxProtocolError("invalid_attestation");
  }

  const capabilities = record(body.capabilities);
  exactKeys(capabilities, [
    "ephemeralWorkspace",
    "computeLimits",
    "egressAllowlist",
    "credentialInjection",
    "hostMounts",
    "directBusinessMutation",
  ]);

  return {
    attestationId: string(body.attestationId),
    backendId: string(body.backendId),
    provider: string(body.provider),
    isolation: body.isolation as SandboxIsolation,
    measurement: string(body.measurement),
    challenge: string(body.challenge),
    issuedAtMs: integer(body.issuedAtMs),
    expiresAtMs: integer(body.expiresAtMs),
    capabilities: {
      ephemeralWorkspace: boolean(capabilities.ephemeralWorkspace),
      computeLimits: boolean(capabilities.computeLimits),
      egressAllowlist: boolean(capabilities.egressAllowlist),
      credentialInjection: boolean(capabilities.credentialInjection),
      hostMounts: boolean(capabilities.hostMounts),
      directBusinessMutation: boolean(capabilities.directBusinessMutation),
    },
  };
}

export async function signSandboxBackendAttestation(
  input: SandboxBackendAttestation,
  signer: SandboxSignatureSigner
): Promise<SignedSandboxBackendAttestation> {
  const body = parseSandboxBackendAttestation(input);
  return {
    body,
    signature: await signSandboxPayload("tulipfarm.sandbox.attestation.v1", body, signer),
  };
}

export interface ProductionAttestationExpectation {
  readonly backendId: string;
  readonly challenge: string;
  readonly nowMs: number;
  readonly requiresCredentialInjection?: boolean;
}

export async function verifyProductionSandboxAttestation(
  input: SignedSandboxBackendAttestation,
  verifier: SandboxSignatureVerifier,
  expected: ProductionAttestationExpectation
): Promise<SandboxBackendAttestation> {
  const signed = record(input);
  exactKeys(signed, ["body", "signature"]);
  const body = parseSandboxBackendAttestation(signed.body);
  await verifySandboxPayload(
    "tulipfarm.sandbox.attestation.v1",
    body,
    signed.signature,
    verifier,
    "invalid_attestation_signature"
  );

  if (
    body.backendId !== expected.backendId ||
    body.challenge !== expected.challenge ||
    body.issuedAtMs > expected.nowMs ||
    body.expiresAtMs <= expected.nowMs ||
    body.expiresAtMs <= body.issuedAtMs
  ) {
    throw new SandboxProtocolError("invalid_attestation");
  }
  if (body.isolation !== "microvm" && body.isolation !== "remote-managed") {
    throw new SandboxProtocolError("weak_backend_isolation");
  }
  if (
    !body.capabilities.ephemeralWorkspace ||
    !body.capabilities.computeLimits ||
    !body.capabilities.egressAllowlist ||
    (expected.requiresCredentialInjection === true && !body.capabilities.credentialInjection) ||
    body.capabilities.hostMounts ||
    body.capabilities.directBusinessMutation
  ) {
    throw new SandboxProtocolError("weak_backend_isolation");
  }
  return body;
}
