/** Detached signature envelope over canonical JSON: sandbox bodies are signed, never trusted raw. */

import {
  parseSandboxExecutionRequest,
  parseSandboxExecutionResult,
  type SandboxExecutionRequest,
  type SandboxExecutionResult,
} from "./request";
import {
  assertExactKeys,
  assertRecord,
  isRecord,
  requireString,
  SandboxProtocolError,
  type SandboxProtocolErrorCode,
} from "./wire";

export interface SandboxSignature {
  readonly keyId: string;
  readonly value: string;
}

export interface SignedSandboxExecutionRequest {
  readonly body: SandboxExecutionRequest;
  readonly signature: SandboxSignature;
}

export interface SignedSandboxExecutionResult {
  readonly body: SandboxExecutionResult;
  readonly signature: SandboxSignature;
}

export interface SandboxSignatureSigner {
  readonly keyId: string;
  sign(payload: Uint8Array): Promise<string>;
}

export interface SandboxSignatureVerifier {
  verify(keyId: string, payload: Uint8Array, signature: string): Promise<boolean>;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  throw new SandboxProtocolError("unsafe_request_shape");
}

function utf8(value: string): Uint8Array {
  const bytes: number[] = [];
  for (const character of value) {
    const point = character.codePointAt(0);
    if (point === undefined) {
      continue;
    }
    if (point <= 0x7f) {
      bytes.push(point);
    } else if (point <= 0x7ff) {
      bytes.push(0xc0 | (point >> 6), 0x80 | (point & 0x3f));
    } else if (point <= 0xffff) {
      bytes.push(0xe0 | (point >> 12), 0x80 | ((point >> 6) & 0x3f), 0x80 | (point & 0x3f));
    } else {
      bytes.push(
        0xf0 | (point >> 18),
        0x80 | ((point >> 12) & 0x3f),
        0x80 | ((point >> 6) & 0x3f),
        0x80 | (point & 0x3f)
      );
    }
  }
  return Uint8Array.from(bytes);
}

function signingPayload(domain: string, body: unknown): Uint8Array {
  return utf8(`${domain}\n${canonicalJson(body)}`);
}

export async function signSandboxPayload(
  domain: string,
  body: unknown,
  signer: SandboxSignatureSigner
): Promise<SandboxSignature> {
  if (signer.keyId.length === 0) {
    throw new SandboxProtocolError("unsafe_request_shape");
  }
  return {
    keyId: signer.keyId,
    value: await signer.sign(signingPayload(domain, body)),
  };
}

export async function verifySandboxPayload(
  domain: string,
  body: unknown,
  signatureInput: unknown,
  verifier: SandboxSignatureVerifier,
  invalidCode: SandboxProtocolErrorCode
): Promise<void> {
  const signature = assertRecord(signatureInput, invalidCode);
  assertExactKeys(signature, ["keyId", "value"], invalidCode);
  const keyId = requireString(signature.keyId, invalidCode);
  const value = requireString(signature.value, invalidCode);
  if (!(await verifier.verify(keyId, signingPayload(domain, body), value))) {
    throw new SandboxProtocolError(invalidCode);
  }
}

export async function signSandboxExecutionRequest(
  input: SandboxExecutionRequest,
  signer: SandboxSignatureSigner
): Promise<SignedSandboxExecutionRequest> {
  const body = parseSandboxExecutionRequest(input);
  return {
    body,
    signature: await signSandboxPayload("tulipfarm.sandbox.request.v1", body, signer),
  };
}

export async function verifySandboxExecutionRequest(
  input: SignedSandboxExecutionRequest,
  verifier: SandboxSignatureVerifier
): Promise<SandboxExecutionRequest> {
  const signed = assertRecord(input, "invalid_request_signature");
  assertExactKeys(signed, ["body", "signature"], "invalid_request_signature");
  const body = parseSandboxExecutionRequest(signed.body);
  await verifySandboxPayload(
    "tulipfarm.sandbox.request.v1",
    body,
    signed.signature,
    verifier,
    "invalid_request_signature"
  );
  return body;
}

export async function signSandboxExecutionResult(
  input: SandboxExecutionResult,
  signer: SandboxSignatureSigner
): Promise<SignedSandboxExecutionResult> {
  const body = parseSandboxExecutionResult(input);
  return {
    body,
    signature: await signSandboxPayload("tulipfarm.sandbox.result.v1", body, signer),
  };
}

export async function verifySandboxExecutionResult(
  input: SignedSandboxExecutionResult,
  verifier: SandboxSignatureVerifier
): Promise<SandboxExecutionResult> {
  const signed = assertRecord(input, "invalid_result_signature");
  assertExactKeys(signed, ["body", "signature"], "invalid_result_signature");
  const body = parseSandboxExecutionResult(signed.body);
  await verifySandboxPayload(
    "tulipfarm.sandbox.result.v1",
    body,
    signed.signature,
    verifier,
    "invalid_result_signature"
  );
  return body;
}
