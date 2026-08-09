/**
 * Signed control-plane request/result contract for isolated sandbox work.
 *
 * The wire shape deliberately has no environment, Credential, host-mount, or business-mutation
 * fields. Inputs and durable outputs cross the boundary only as Artifact references.
 */

export type SandboxProtocolErrorCode =
  | "backend_failure"
  | "compute_limit_exceeded"
  | "egress_denied"
  | "guardrail_missing"
  | "invalid_attestation"
  | "invalid_attestation_signature"
  | "invalid_request_signature"
  | "invalid_result_shape"
  | "invalid_result_signature"
  | "request_expired"
  | "request_lifetime_exceeded"
  | "request_not_current"
  | "request_replayed"
  | "result_binding_mismatch"
  | "result_limit_exceeded"
  | "unsafe_request_shape"
  | "weak_backend_isolation"
  | "workspace_limit_exceeded"
  | "workspace_not_destroyed";

const ERROR_MESSAGES: Readonly<Record<SandboxProtocolErrorCode, string>> = {
  backend_failure: "sandbox backend failed",
  compute_limit_exceeded: "sandbox compute limit denied",
  egress_denied: "sandbox egress denied",
  guardrail_missing: "sandbox guardrail is required",
  invalid_attestation: "sandbox backend attestation is invalid",
  invalid_attestation_signature: "sandbox backend attestation signature is invalid",
  invalid_request_signature: "sandbox request signature is invalid",
  invalid_result_shape: "sandbox result is invalid",
  invalid_result_signature: "sandbox result signature is invalid",
  request_expired: "sandbox request has expired",
  request_lifetime_exceeded: "sandbox request lifetime exceeds the guardrail",
  request_not_current: "sandbox request is not current",
  request_replayed: "sandbox request has already been claimed",
  result_binding_mismatch: "sandbox result does not match the request",
  result_limit_exceeded: "sandbox result exceeded an execution limit",
  unsafe_request_shape: "sandbox request contains an unsafe or invalid field",
  weak_backend_isolation: "sandbox backend cannot satisfy production isolation",
  workspace_limit_exceeded: "sandbox workspace limit denied",
  workspace_not_destroyed: "sandbox workspace destruction was not attested",
};

export class SandboxProtocolError extends Error {
  constructor(readonly code: SandboxProtocolErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "SandboxProtocolError";
  }
}

export interface SandboxComputeLimits {
  readonly timeoutMs: number;
  readonly cpuMillis: number;
  readonly memoryBytes: number;
  readonly outputBytes: number;
}

export interface SandboxCredentialBinding {
  readonly slot: string;
  /** Opaque one-use Secret lease reference; never credential plaintext. */
  readonly leaseRef: string;
  readonly injectAs: {
    readonly kind: "file" | "environment";
    readonly name: string;
  };
}

export interface SandboxFileOutputDeclaration {
  readonly name: string;
  readonly path: string;
  readonly mediaTypes: readonly string[];
  readonly maxBytes: number;
}

export interface SandboxPublishedFileOutput {
  readonly name: string;
  readonly artifactRef: string;
  readonly mediaType: string;
  readonly bytes: number;
}

export interface SandboxExecutionRequest {
  readonly requestId: string;
  /** One-use value bound into the backend attestation and result. */
  readonly nonce: string;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
  /** `tool` means the Tool Broker authorized and reserved this execution before dispatch. */
  readonly operation: "compute" | "tool";
  readonly workspace: {
    readonly kind: "ephemeral";
    readonly maxBytes: number;
  };
  readonly entrypoint: {
    /** Immutable, scanned Skill script or asset. Never a host path. */
    readonly artifactRef: string;
    readonly argv: readonly string[];
  };
  readonly inputArtifactRefs: readonly string[];
  readonly compute: SandboxComputeLimits;
  readonly egress: {
    /** Guardrail-owned destination identifiers, not user-authored URLs. Empty denies network. */
    readonly destinationIds: readonly string[];
    readonly maxBytes: number;
  };
  readonly runtimeProfile?: {
    readonly id: string;
    readonly imageDigest: string;
  };
  readonly credentialBindings?: readonly SandboxCredentialBinding[];
  readonly outputs?: {
    readonly jsonPath: string;
    readonly files: readonly SandboxFileOutputDeclaration[];
  };
}

export interface SandboxExecutionResult {
  readonly requestId: string;
  readonly nonce: string;
  readonly exitCode: number;
  readonly timedOut: boolean;
  /** Captured output is scanned and published separately; plaintext never enters this result. */
  readonly stdoutArtifactRef: string;
  readonly stderrArtifactRef: string;
  readonly outputs?: {
    readonly jsonArtifactRef: string;
    readonly files: readonly SandboxPublishedFileOutput[];
  };
  readonly usage: {
    readonly cpuMillis: number;
    readonly maxMemoryBytes: number;
    readonly outputBytes: number;
    readonly egressBytes: number;
  };
  readonly workspace: {
    readonly kind: "ephemeral";
    readonly destroyed: boolean;
  };
  readonly startedAtMs: number;
  readonly completedAtMs: number;
}

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

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertRecord(value: unknown, code: SandboxProtocolErrorCode): UnknownRecord {
  if (!isRecord(value)) {
    throw new SandboxProtocolError(code);
  }
  return value;
}

function assertExactKeys(
  value: UnknownRecord,
  keys: readonly string[],
  code: SandboxProtocolErrorCode
): void {
  const allowed = new Set(keys);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new SandboxProtocolError(code);
  }
  if (keys.some((key) => !(key in value))) {
    throw new SandboxProtocolError(code);
  }
}

function assertKeysWithOptional(
  value: UnknownRecord,
  required: readonly string[],
  optional: readonly string[],
  code: SandboxProtocolErrorCode
): void {
  const allowed = new Set([...required, ...optional]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new SandboxProtocolError(code);
  }
  if (required.some((key) => !(key in value))) {
    throw new SandboxProtocolError(code);
  }
}

function requireString(value: unknown, code: SandboxProtocolErrorCode): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) {
    throw new SandboxProtocolError(code);
  }
  return value;
}

function requireInteger(value: unknown, code: SandboxProtocolErrorCode, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new SandboxProtocolError(code);
  }
  return value as number;
}

function requireBoolean(value: unknown, code: SandboxProtocolErrorCode): boolean {
  if (typeof value !== "boolean") {
    throw new SandboxProtocolError(code);
  }
  return value;
}

function requireStringArray(value: unknown, code: SandboxProtocolErrorCode): readonly string[] {
  if (!Array.isArray(value) || value.length > 1_000) {
    throw new SandboxProtocolError(code);
  }
  return value.map((item) => requireString(item, code));
}

export function parseSandboxExecutionRequest(input: unknown): SandboxExecutionRequest {
  const code = "unsafe_request_shape";
  const body = assertRecord(input, code);
  const baseKeys = [
    "requestId",
    "nonce",
    "issuedAtMs",
    "expiresAtMs",
    "operation",
    "workspace",
    "entrypoint",
    "inputArtifactRefs",
    "compute",
    "egress",
  ] as const;
  if (body.operation === "tool") {
    assertExactKeys(body, [...baseKeys, "runtimeProfile", "credentialBindings", "outputs"], code);
  } else {
    assertExactKeys(body, baseKeys, code);
  }

  const workspace = assertRecord(body.workspace, code);
  assertExactKeys(workspace, ["kind", "maxBytes"], code);
  if (workspace.kind !== "ephemeral") {
    throw new SandboxProtocolError(code);
  }

  const entrypoint = assertRecord(body.entrypoint, code);
  assertExactKeys(entrypoint, ["artifactRef", "argv"], code);

  const compute = assertRecord(body.compute, code);
  assertExactKeys(compute, ["timeoutMs", "cpuMillis", "memoryBytes", "outputBytes"], code);

  const egress = assertRecord(body.egress, code);
  assertExactKeys(egress, ["destinationIds", "maxBytes"], code);
  const destinationIds = requireStringArray(egress.destinationIds, code);
  if (new Set(destinationIds).size !== destinationIds.length) {
    throw new SandboxProtocolError(code);
  }

  if (body.operation !== "compute" && body.operation !== "tool") {
    throw new SandboxProtocolError(code);
  }

  let toolFields:
    | Pick<SandboxExecutionRequest, "runtimeProfile" | "credentialBindings" | "outputs">
    | undefined;
  if (body.operation === "tool") {
    const runtimeProfile = assertRecord(body.runtimeProfile, code);
    assertExactKeys(runtimeProfile, ["id", "imageDigest"], code);
    const imageDigest = requireString(runtimeProfile.imageDigest, code);
    if (!/^sha256:[0-9a-f]{64}$/.test(imageDigest)) throw new SandboxProtocolError(code);

    if (!Array.isArray(body.credentialBindings) || body.credentialBindings.length > 16) {
      throw new SandboxProtocolError(code);
    }
    const slots = new Set<string>();
    const credentialBindings = body.credentialBindings.map((value) => {
      const binding = assertRecord(value, code);
      assertExactKeys(binding, ["slot", "leaseRef", "injectAs"], code);
      const injectAs = assertRecord(binding.injectAs, code);
      assertExactKeys(injectAs, ["kind", "name"], code);
      let kind: "file" | "environment";
      if (injectAs.kind === "file" || injectAs.kind === "environment") {
        kind = injectAs.kind;
      } else {
        throw new SandboxProtocolError(code);
      }
      const slot = requireString(binding.slot, code);
      if (!/^[a-z][a-z0-9_]*$/.test(slot) || slots.has(slot)) {
        throw new SandboxProtocolError(code);
      }
      slots.add(slot);
      return {
        slot,
        leaseRef: requireString(binding.leaseRef, code),
        injectAs: {
          kind,
          name: requireString(injectAs.name, code),
        },
      };
    });

    const outputs = assertRecord(body.outputs, code);
    assertExactKeys(outputs, ["jsonPath", "files"], code);
    if (!Array.isArray(outputs.files) || outputs.files.length > 32) {
      throw new SandboxProtocolError(code);
    }
    const outputNames = new Set<string>();
    const outputPaths = new Set<string>();
    const files = outputs.files.map((value) => {
      const file = assertRecord(value, code);
      assertExactKeys(file, ["name", "path", "mediaTypes", "maxBytes"], code);
      const name = requireString(file.name, code);
      const path = requireSafeRelativePath(file.path, code);
      const mediaTypes = requireStringArray(file.mediaTypes, code);
      if (
        mediaTypes.length === 0 ||
        outputNames.has(name) ||
        outputPaths.has(path) ||
        !/^[a-z][a-z0-9_]*$/.test(name)
      ) {
        throw new SandboxProtocolError(code);
      }
      outputNames.add(name);
      outputPaths.add(path);
      return {
        name,
        path,
        mediaTypes,
        maxBytes: requireInteger(file.maxBytes, code, 1),
      };
    });
    toolFields = {
      runtimeProfile: {
        id: requireString(runtimeProfile.id, code),
        imageDigest,
      },
      credentialBindings,
      outputs: {
        jsonPath: requireSafeRelativePath(outputs.jsonPath, code),
        files,
      },
    };
  }

  return {
    requestId: requireString(body.requestId, code),
    nonce: requireString(body.nonce, code),
    issuedAtMs: requireInteger(body.issuedAtMs, code),
    expiresAtMs: requireInteger(body.expiresAtMs, code),
    operation: body.operation,
    workspace: {
      kind: "ephemeral",
      maxBytes: requireInteger(workspace.maxBytes, code, 1),
    },
    entrypoint: {
      artifactRef: requireString(entrypoint.artifactRef, code),
      argv: requireStringArray(entrypoint.argv, code),
    },
    inputArtifactRefs: requireStringArray(body.inputArtifactRefs, code),
    compute: {
      timeoutMs: requireInteger(compute.timeoutMs, code, 1),
      cpuMillis: requireInteger(compute.cpuMillis, code, 1),
      memoryBytes: requireInteger(compute.memoryBytes, code, 1),
      outputBytes: requireInteger(compute.outputBytes, code, 1),
    },
    egress: {
      destinationIds,
      maxBytes: requireInteger(egress.maxBytes, code),
    },
    ...toolFields,
  };
}

function requireSafeRelativePath(value: unknown, code: SandboxProtocolErrorCode): string {
  const path = requireString(value, code);
  const segments = path.split("/");
  if (
    path.startsWith("/") ||
    path.includes("\\") ||
    segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new SandboxProtocolError(code);
  }
  return path;
}

export function parseSandboxExecutionResult(input: unknown): SandboxExecutionResult {
  const code = "invalid_result_shape";
  const body = assertRecord(input, code);
  assertKeysWithOptional(
    body,
    [
      "requestId",
      "nonce",
      "exitCode",
      "timedOut",
      "stdoutArtifactRef",
      "stderrArtifactRef",
      "usage",
      "workspace",
      "startedAtMs",
      "completedAtMs",
    ],
    ["outputs"],
    code
  );

  const usage = assertRecord(body.usage, code);
  assertExactKeys(usage, ["cpuMillis", "maxMemoryBytes", "outputBytes", "egressBytes"], code);
  const workspace = assertRecord(body.workspace, code);
  assertExactKeys(workspace, ["kind", "destroyed"], code);
  if (workspace.kind !== "ephemeral") {
    throw new SandboxProtocolError(code);
  }

  let outputs: SandboxExecutionResult["outputs"];
  if (body.outputs !== undefined) {
    const output = assertRecord(body.outputs, code);
    assertExactKeys(output, ["jsonArtifactRef", "files"], code);
    if (!Array.isArray(output.files) || output.files.length > 32) {
      throw new SandboxProtocolError(code);
    }
    outputs = {
      jsonArtifactRef: requireString(output.jsonArtifactRef, code),
      files: output.files.map((value) => {
        const file = assertRecord(value, code);
        assertExactKeys(file, ["name", "artifactRef", "mediaType", "bytes"], code);
        return {
          name: requireString(file.name, code),
          artifactRef: requireString(file.artifactRef, code),
          mediaType: requireString(file.mediaType, code),
          bytes: requireInteger(file.bytes, code),
        };
      }),
    };
  }

  return {
    requestId: requireString(body.requestId, code),
    nonce: requireString(body.nonce, code),
    exitCode: requireInteger(body.exitCode, code, -2_147_483_648),
    timedOut: requireBoolean(body.timedOut, code),
    stdoutArtifactRef: requireString(body.stdoutArtifactRef, code),
    stderrArtifactRef: requireString(body.stderrArtifactRef, code),
    ...(outputs === undefined ? {} : { outputs }),
    usage: {
      cpuMillis: requireInteger(usage.cpuMillis, code),
      maxMemoryBytes: requireInteger(usage.maxMemoryBytes, code),
      outputBytes: requireInteger(usage.outputBytes, code),
      egressBytes: requireInteger(usage.egressBytes, code),
    },
    workspace: {
      kind: "ephemeral",
      destroyed: requireBoolean(workspace.destroyed, code),
    },
    startedAtMs: requireInteger(body.startedAtMs, code),
    completedAtMs: requireInteger(body.completedAtMs, code),
  };
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
