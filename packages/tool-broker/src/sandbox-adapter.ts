import { randomUUID } from "node:crypto";
import type {
  PinnedSkillBundle,
  SandboxComputeLimits,
  SandboxFileOutputDeclaration,
  SandboxRuntimeProfile,
  SandboxRuntimeProfileRegistry,
  SkillExecutionCoordinator,
  SkillGitTarget,
} from "@tulipfarm/sandbox";
import { AdapterDispatchError, type ToolAdapter, type ToolAdapterRequest } from "./effects";

export interface PublishedSandboxCommand {
  readonly toolId: string;
  readonly toolVersion: string;
  readonly bundle: PinnedSkillBundle;
  readonly requestedAssetPaths: readonly string[];
  readonly runtimeProfile: string;
  readonly requiredCommands: readonly string[];
  readonly staticArgs: readonly string[];
  readonly compute: SandboxComputeLimits;
  readonly workspaceMaxBytes: number;
  readonly maxEgressBytes: number;
  readonly jsonOutputPath: string;
  readonly fileOutputs: readonly SandboxFileOutputDeclaration[];
  readonly gitTargets: readonly SkillGitTarget[];
  readonly integrationBinding?: {
    readonly slot: string;
    readonly injectAs: { readonly kind: "file" | "environment"; readonly name: string };
  };
}

export interface SandboxCommandResolver {
  resolve(toolId: string, toolVersion: string): PublishedSandboxCommand | undefined;
}

export interface SandboxToolInputPublisher {
  publish(input: {
    readonly businessId: string;
    readonly runId: string;
    readonly stateId: string;
    readonly arguments: unknown;
  }): Promise<string>;
}

export interface SandboxCredentialLeaseHandle {
  readonly leaseRef: string;
  revoke(): Promise<void>;
}

export interface SandboxCredentialLeaseIssuer {
  issue(input: {
    readonly requestId: string;
    readonly slot: string;
    readonly credential: string;
    readonly expiresAtMs: number;
  }): Promise<SandboxCredentialLeaseHandle>;
}

export interface SandboxToolOutputReader {
  readJson(artifactRef: string): Promise<unknown>;
}

export interface SandboxToolAdapterOptions {
  readonly commands: SandboxCommandResolver;
  readonly runtimes: SandboxRuntimeProfileRegistry;
  readonly inputs: SandboxToolInputPublisher;
  readonly credentials: SandboxCredentialLeaseIssuer;
  readonly outputs: SandboxToolOutputReader;
  readonly executor: Pick<SkillExecutionCoordinator, "execute">;
  readonly now?: () => number;
  readonly nonce?: () => string;
  readonly requestLifetimeMs?: number;
}

function preflight(code: string): AdapterDispatchError {
  return new AdapterDispatchError("before_dispatch", code, false);
}

/**
 * Tool adapter for one published Skill command. The EffectDispatcher reaches this only after the
 * Tool Broker authorized and durably reserved the effect. It converts the Tool's JSON arguments
 * into an immutable input Artifact and never puts credential plaintext on the sandbox wire.
 */
export class SandboxToolAdapter implements ToolAdapter {
  private readonly now: () => number;
  private readonly nonce: () => string;
  private readonly requestLifetimeMs: number;

  constructor(private readonly options: SandboxToolAdapterOptions) {
    this.now = options.now ?? (() => Date.now());
    this.nonce = options.nonce ?? randomUUID;
    this.requestLifetimeMs = options.requestLifetimeMs ?? 60_000;
  }

  async dispatch(request: ToolAdapterRequest, credential?: string): Promise<unknown> {
    const command = this.options.commands.resolve(
      request.intent.toolId,
      request.intent.toolVersion
    );
    if (command === undefined) throw preflight("sandbox_command_not_found");

    let runtime: SandboxRuntimeProfile;
    try {
      runtime = this.options.runtimes.require(command.runtimeProfile, command.requiredCommands);
    } catch {
      throw preflight("sandbox_runtime_unavailable");
    }
    if (command.integrationBinding !== undefined && credential === undefined) {
      throw preflight("sandbox_credential_required");
    }
    if (command.integrationBinding === undefined && credential !== undefined) {
      throw preflight("sandbox_credential_undeclared");
    }

    const issuedAtMs = this.now();
    const expiresAtMs = issuedAtMs + this.requestLifetimeMs;
    const inputArtifactRef = await this.options.inputs.publish({
      businessId: request.intent.businessId,
      runId: request.intent.runId,
      stateId: request.intent.stateId,
      arguments: request.intent.arguments,
    });
    let lease: SandboxCredentialLeaseHandle | undefined;
    if (command.integrationBinding !== undefined && credential !== undefined) {
      lease = await this.options.credentials.issue({
        requestId: request.intent.intentId,
        slot: command.integrationBinding.slot,
        credential,
        expiresAtMs,
      });
    }

    try {
      const outcome = await this.options.executor.execute({
        requestId: request.intent.intentId,
        nonce: this.nonce(),
        issuedAtMs,
        expiresAtMs,
        bundle: command.bundle,
        requestedAssetPaths: command.requestedAssetPaths,
        inputArtifactRefs: [inputArtifactRef],
        argv: command.staticArgs,
        compute: command.compute,
        workspaceMaxBytes: command.workspaceMaxBytes,
        web: {
          destinationIds:
            request.intent.destination === undefined ? [] : [request.intent.destination],
          maxBytes: request.intent.destination === undefined ? 0 : command.maxEgressBytes,
        },
        gitTargets: command.gitTargets,
        runtimeProfile: { id: runtime.id, imageDigest: runtime.imageDigest },
        credentialBindings:
          lease === undefined || command.integrationBinding === undefined
            ? []
            : [
                {
                  slot: command.integrationBinding.slot,
                  leaseRef: lease.leaseRef,
                  injectAs: command.integrationBinding.injectAs,
                },
              ],
        outputs: {
          jsonPath: command.jsonOutputPath,
          files: command.fileOutputs,
        },
      });
      if (outcome.sandboxResult.timedOut || outcome.sandboxResult.exitCode !== 0) {
        // The process may have reached a declared mutation destination before failing. Preserve
        // ambiguity so reconciliation or a human decides; never blindly retry the script.
        throw new AdapterDispatchError("after_dispatch", "sandbox_command_failed", false);
      }
      const outputRef =
        outcome.sandboxResult.outputs?.jsonArtifactRef ?? outcome.outputArtifact.artifactRef;
      return await this.options.outputs.readJson(outputRef);
    } finally {
      await lease?.revoke();
    }
  }
}
