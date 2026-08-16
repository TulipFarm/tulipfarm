/** Sandbox requests/results carry signed Artifact refs only: no env, credentials, or mounts. */

import {
  assertExactKeys,
  assertKeysWithOptional,
  assertRecord,
  requireBoolean,
  requireInteger,
  requireSafeRelativePath,
  requireString,
  requireStringArray,
  SandboxProtocolError,
} from "./wire";

export type { SandboxProtocolErrorCode } from "./wire";
export { SandboxProtocolError };

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
