import { createHash, randomUUID } from "node:crypto";
import { basename } from "node:path";
import type { ArtifactService } from "@tulipfarm/run-kernel";
import {
  DevelopmentContainerSandboxExecutor,
  type DevelopmentSandboxArtifactReader,
  type DevelopmentSandboxCredentialReader,
  type DevelopmentSandboxOutputPublisher,
  DockerNetworkEgressPort,
  type ResolvedSkillArtifact,
  SandboxRuntimeProfileRegistry,
  SkillExecutionCoordinator,
  type SkillOutputScanner,
  shellTsPythonV1,
} from "@tulipfarm/sandbox";
import { type RuntimeBundle, resolveRuntimeSkillCommands } from "@tulipfarm/soul";
import {
  type SandboxCredentialLeaseHandle,
  type SandboxCredentialLeaseIssuer,
  SandboxToolAdapter,
  type ToolAdapter,
} from "@tulipfarm/tool-broker";

/**
 * The minimum a caller must name to run a Skill command: whose deployment, which Run and State the
 * work is attributed to, and the exact verified bundle the command is resolved from.
 *
 * Structural rather than the Routine's own request type, because a Chat Turn reaches the same
 * adapters with no dispatch plan and no authority layers of its own.
 */
export interface SandboxToolingRequest {
  readonly businessId: string;
  readonly runId: string;
  /** Durable State occurrence key; the ledger's `state_id`. */
  readonly stateKey: string;
  /** The exact pinned bundle — the only source of commands, contracts and policy. */
  readonly bundle: RuntimeBundle;
}

const WORKER_READER = "service:worker";
const MAX_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 16_000_000;
const MAX_WORKSPACE_BYTES = 64_000_000;
const MAX_MEMORY_BYTES = 256_000_000;
const MAX_EGRESS_BYTES = 10_000_000;

/** The ceilings every sandbox entry point shares; a caller may ask for less, never more. */
export const SANDBOX_LIMITS = {
  timeoutMs: MAX_TIMEOUT_MS,
  outputBytes: MAX_OUTPUT_BYTES,
  workspaceBytes: MAX_WORKSPACE_BYTES,
  memoryBytes: MAX_MEMORY_BYTES,
  egressBytes: MAX_EGRESS_BYTES,
  requestLifetimeMs: 60_000,
} as const;
const IMAGE = /^(.+)@(sha256:[0-9a-f]{64})$/;
const PACKAGE_INSTALL = /(?:^|\s)(?:npm|pnpm|yarn|pip|pip3|apt|apk|brew)\s+(?:add|i|install)\b/m;
const DIRECT_NETWORK_MUTATION =
  /\bcurl\b[^\n]*(?:-X|--request)\s*(?:POST|PUT|PATCH|DELETE)\b|\bfetch\s*\([^\n]+method\s*:\s*["'](?:POST|PUT|PATCH|DELETE)/i;

function artifactRef(id: string): string {
  return `artifact://${id}`;
}

function artifactId(ref: string): string {
  const prefix = "artifact://";
  if (!ref.startsWith(prefix) || ref.slice(prefix.length).includes("/")) {
    throw new Error("invalid_sandbox_artifact_ref");
  }
  return ref.slice(prefix.length);
}

function stableId(...parts: readonly string[]): string {
  return `sandbox-${createHash("sha256").update(parts.join("\0")).digest("hex")}`;
}

interface ArtifactContext {
  readonly artifacts: ArtifactService;
  readonly businessId: string;
  readonly runId: string;
  readonly stateKey: string;
  readonly now: () => Date;
}

function fileMetadata(context: ArtifactContext) {
  const createdAt = context.now();
  return {
    businessId: context.businessId,
    classification: [] as readonly string[],
    acl: { readers: [WORKER_READER] },
    retention: {
      policy: "ephemeral" as const,
      expiresAt: new Date(createdAt.getTime() + 24 * 60 * 60 * 1_000).toISOString(),
    },
    redaction: { redactedPaths: [] as readonly string[] },
    producer: { runId: context.runId, stateKey: context.stateKey, attempt: 1 },
    createdAt: createdAt.toISOString(),
  };
}

class ArtifactBridge
  implements DevelopmentSandboxArtifactReader, DevelopmentSandboxOutputPublisher
{
  constructor(private readonly context: ArtifactContext) {}

  async read(ref: string) {
    const file = await this.context.artifacts.openFile({
      businessId: this.context.businessId,
      artifactId: artifactId(ref),
      reader: WORKER_READER,
      allowedClassifications: [],
      now: this.context.now(),
    });
    return { fileName: file.fileName, bytes: file.bytes };
  }

  async publish(input: {
    readonly requestId: string;
    readonly name: string;
    readonly bytes: Uint8Array;
    readonly mediaType: string;
  }): Promise<string> {
    const id = stableId(
      input.requestId,
      input.name,
      createHash("sha256").update(input.bytes).digest("hex")
    );
    await this.context.artifacts.publishFile({
      id,
      bytes: input.bytes,
      mediaType: input.mediaType,
      fileName: input.name,
      ...fileMetadata(this.context),
    });
    return artifactRef(id);
  }
}

interface LeaseRecord {
  readonly value: string;
  readonly expiresAtMs: number;
  used: boolean;
  revoked: boolean;
}

class OneUseCredentialLeases
  implements SandboxCredentialLeaseIssuer, DevelopmentSandboxCredentialReader
{
  private readonly records = new Map<string, LeaseRecord>();
  private readonly secretsByRequest = new Map<string, Set<string>>();

  constructor(private readonly now: () => number) {}

  async issue(input: {
    readonly requestId: string;
    readonly slot: string;
    readonly credential: string;
    readonly expiresAtMs: number;
  }): Promise<SandboxCredentialLeaseHandle> {
    const leaseRef = `sandbox-lease:${randomUUID()}`;
    this.records.set(leaseRef, {
      value: input.credential,
      expiresAtMs: input.expiresAtMs,
      used: false,
      revoked: false,
    });
    const secrets = this.secretsByRequest.get(input.requestId) ?? new Set<string>();
    secrets.add(input.credential);
    this.secretsByRequest.set(input.requestId, secrets);
    return {
      leaseRef,
      revoke: async () => {
        const record = this.records.get(leaseRef);
        if (record !== undefined) record.revoked = true;
        this.records.delete(leaseRef);
        this.secretsByRequest.delete(input.requestId);
      },
    };
  }

  async read(leaseRef: string): Promise<string> {
    const record = this.records.get(leaseRef);
    if (record === undefined || record.revoked || record.used || this.now() >= record.expiresAtMs) {
      throw new Error("sandbox_credential_lease_denied");
    }
    record.used = true;
    return record.value;
  }

  secrets(requestId: string): readonly string[] {
    return [...(this.secretsByRequest.get(requestId) ?? [])];
  }
}

function outputScanner(bridge: ArtifactBridge, leases: OneUseCredentialLeases): SkillOutputScanner {
  return {
    async scan(input) {
      const refs = [
        input.stdoutArtifactRef,
        input.stderrArtifactRef,
        ...(input.outputArtifactRefs ?? []),
      ];
      const secrets = leases.secrets(input.requestId);
      for (const ref of refs) {
        const text = new TextDecoder().decode((await bridge.read(ref)).bytes);
        if (secrets.some((secret) => secret.length > 0 && text.includes(secret))) {
          return { verdict: "rejected", scanId: `scan:${input.requestId}` };
        }
      }
      return { verdict: "clean", scanId: `scan:${input.requestId}` };
    },
  };
}

function scanAssetContent(content: string) {
  return {
    rejected: PACKAGE_INSTALL.test(content),
    findings: DIRECT_NETWORK_MUTATION.test(content)
      ? (["direct_network_mutation"] as const)
      : ([] as const),
  };
}

/**
 * Publish content the runtime generated rather than read from a bundle. The caller derives
 * `expectedDigest` from these exact bytes, so re-hashing here is a self-check that the generator
 * and the pinned bundle it handed the coordinator never drifted apart.
 */
async function publishSyntheticAsset(
  context: ArtifactContext,
  path: string,
  expectedDigest: string,
  content: string
): Promise<ResolvedSkillArtifact> {
  const bytes = new TextEncoder().encode(content);
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== expectedDigest) throw new Error("sandbox_asset_digest_mismatch");
  const scan = scanAssetContent(content);
  const id = stableId("synthetic", path, digest, context.runId, context.stateKey);
  await context.artifacts.publishFile({
    id,
    bytes,
    mediaType: "text/plain",
    fileName: basename(path),
    ...fileMetadata(context),
  });
  return {
    artifactRef: artifactRef(id),
    digest,
    scan: { verdict: scan.rejected ? "rejected" : "clean", findings: scan.findings },
  };
}

function resolvedAsset(
  bundle: RuntimeBundle,
  context: ArtifactContext,
  path: string,
  expectedDigest: string
): Promise<ResolvedSkillArtifact> {
  const asset = bundle.assets.find(
    (candidate) => candidate.path === path && candidate.digest === expectedDigest
  );
  if (asset === undefined) throw new Error("sandbox_asset_not_found");
  const { rejected, findings } = scanAssetContent(asset.content);
  // Scoped to the execution, not just the content. Artifact rows are append-only and
  // `artifactMatchesInput` compares `createdAt`, `retention` and `producer`, all of which move
  // between executions — so a purely content-addressed id makes the second run of any command
  // fail with `artifact_conflict`. The blob store still dedupes the bytes by content hash.
  const id = stableId(
    bundle.digest,
    asset.ownerDefinitionId,
    asset.path,
    asset.digest,
    context.runId,
    context.stateKey
  );
  return context.artifacts
    .publishFile({
      id,
      bytes: new TextEncoder().encode(asset.content),
      mediaType: "text/plain",
      fileName: basename(asset.path),
      ...fileMetadata(context),
    })
    .then(() => ({
      artifactRef: artifactRef(id),
      digest: asset.digest,
      scan: { verdict: rejected ? "rejected" : "clean", findings },
    }));
}

export interface BundleSandboxToolingOptions {
  readonly artifacts: ArtifactService;
  /** Development-only immutable `repository@sha256:...` reference. */
  readonly runtimeImage?: string;
  readonly now?: () => Date;
}

export interface SandboxStack {
  readonly context: ArtifactContext;
  readonly bridge: ArtifactBridge;
  readonly leases: OneUseCredentialLeases;
  readonly runtimes: SandboxRuntimeProfileRegistry;
  readonly coordinator: SkillExecutionCoordinator;
  readonly runtimeProfileId: string;
  readonly imageDigest: string;
  readonly now: () => Date;
}

export interface SandboxStackOverrides {
  /** Destinations the container may reach; anything else keeps it on `--network=none`. */
  readonly allowedEgressDestinationIds: (bundle: RuntimeBundle) => readonly string[];
  /**
   * Content for entrypoints that are generated rather than published, keyed by asset path. A
   * verified bundle never needs this; an inline `skill` shell command has no bundle asset to
   * resolve, so the runner supplies the exact bytes it hashed the digest from.
   */
  readonly syntheticAssets?: ReadonlyMap<string, string>;
}

/**
 * Assemble the executor, coordinator and artifact plumbing shared by every sandbox entry point.
 * Returns `undefined` when no usable `repository@sha256:...` image is configured, which is the
 * signal to disable sandbox execution rather than fail a call.
 */
export function createSandboxStack(
  request: SandboxToolingRequest,
  options: BundleSandboxToolingOptions,
  overrides: SandboxStackOverrides
): SandboxStack | undefined {
  if (options.runtimeImage === undefined) return undefined;
  const image = IMAGE.exec(options.runtimeImage);
  if (image === null || image[2] === undefined) return undefined;
  const digest = image[2];
  const now = options.now ?? (() => new Date());
  const context: ArtifactContext = {
    artifacts: options.artifacts,
    businessId: request.businessId,
    runId: request.runId,
    stateKey: request.stateKey,
    now,
  };
  const bridge = new ArtifactBridge(context);
  const leases = new OneUseCredentialLeases(() => now().getTime());
  const runtime = shellTsPythonV1(digest);
  const runtimes = new SandboxRuntimeProfileRegistry([runtime]);
  const sandbox = new DevelopmentContainerSandboxExecutor({
    guardrail: {
      maxRequestLifetimeMs: 60_000,
      maxWorkspaceBytes: MAX_WORKSPACE_BYTES,
      maxCompute: {
        timeoutMs: MAX_TIMEOUT_MS,
        cpuMillis: MAX_TIMEOUT_MS,
        memoryBytes: MAX_MEMORY_BYTES,
        outputBytes: MAX_OUTPUT_BYTES,
      },
      allowedEgressDestinationIds: overrides.allowedEgressDestinationIds(request.bundle),
      maxEgressBytes: MAX_EGRESS_BYTES,
      allowedRuntimeProfiles: { [runtime.id]: runtime.imageDigest },
      maxCredentialBindings: 1,
      maxFileOutputs: 32,
    },
    images: { [digest]: options.runtimeImage },
    artifacts: bridge,
    credentials: leases,
    outputs: bridge,
    // Only reached when a command's ToolContract declares `allowedDestinations` and the caller
    // names one; every other Run stays on `--network=none`.
    egress: new DockerNetworkEgressPort({ image: options.runtimeImage }),
    now: () => now().getTime(),
  });
  const coordinator = new SkillExecutionCoordinator({
    assets: {
      resolve: ({ path, expectedDigest }) => {
        const synthetic = overrides.syntheticAssets?.get(path);
        if (synthetic !== undefined) {
          return publishSyntheticAsset(context, path, expectedDigest, synthetic);
        }
        return resolvedAsset(request.bundle, context, path, expectedDigest);
      },
    },
    sandbox,
    outputScanner: outputScanner(bridge, leases),
    outputPublisher: {
      async publish(input) {
        const ref = input.jsonArtifactRef ?? input.stdoutArtifactRef;
        return { artifactId: artifactId(ref), artifactRef: ref };
      },
    },
    gitLocks: {
      async lockGrantedTarget() {
        return { granted: false };
      },
      async release() {},
    },
  });
  return {
    context,
    bridge,
    leases,
    runtimes,
    coordinator,
    runtimeProfileId: runtime.id,
    imageDigest: runtime.imageDigest,
    now,
  };
}

/** Build only verified-bundle command adapters; no dev image means park on `adapter_not_found`. */
export function buildBundleSandboxAdapters(
  request: SandboxToolingRequest,
  options: BundleSandboxToolingOptions
): ReadonlyMap<string, ToolAdapter> {
  if (options.runtimeImage === undefined) return new Map();
  const stack = createSandboxStack(request, options, {
    allowedEgressDestinationIds: (bundle) => [
      ...new Set(
        resolveRuntimeSkillCommands(bundle).flatMap(
          (command) => command.tool.spec.allowedDestinations ?? []
        )
      ),
    ],
  });
  if (stack === undefined) return new Map();
  const { context, bridge, leases, runtimes, coordinator, now } = stack;
  const commands = resolveRuntimeSkillCommands(request.bundle);
  const byTool = new Map(
    commands.map((command) => [
      `${command.tool.spec.toolId}\0${command.tool.spec.toolVersion}`,
      command,
    ])
  );
  const adapters = new Map<string, ToolAdapter>();
  for (const runtimeCommand of commands) {
    const { command, tool } = runtimeCommand;
    const timeoutMs = Math.min(tool.spec.timeout?.activeMs ?? MAX_TIMEOUT_MS, MAX_TIMEOUT_MS);
    const binding = command.integrationBindings?.[0];
    adapters.set(
      tool.spec.adapter.ref,
      new SandboxToolAdapter({
        commands: {
          resolve(toolId, toolVersion) {
            const resolved = byTool.get(`${toolId}\0${toolVersion}`);
            if (resolved === undefined) return undefined;
            return {
              toolId,
              toolVersion,
              bundle: {
                skillId: resolved.skillId,
                version: String(resolved.skillVersion),
                digest: resolved.bundleDigest,
                entrypoint: {
                  path: resolved.entrypoint.path,
                  digest: resolved.entrypoint.digest,
                },
                assets: resolved.assets
                  .filter((asset) => asset.path !== resolved.entrypoint.path)
                  .map((asset) => ({ path: asset.path, digest: asset.digest })),
                webDestinationIds: resolved.tool.spec.allowedDestinations ?? [],
                gitTargets: [],
              },
              requestedAssetPaths: [],
              runtimeProfile: resolved.command.runtimeProfile,
              requiredCommands: resolved.command.requiredCommands ?? [],
              staticArgs: resolved.command.staticArgs ?? [],
              compute: {
                timeoutMs,
                cpuMillis: timeoutMs,
                memoryBytes: MAX_MEMORY_BYTES,
                outputBytes: MAX_OUTPUT_BYTES,
              },
              workspaceMaxBytes: MAX_WORKSPACE_BYTES,
              maxEgressBytes: MAX_EGRESS_BYTES,
              jsonOutputPath: "result.json",
              fileOutputs: resolved.command.fileOutputs ?? [],
              gitTargets: [],
              ...(binding === undefined
                ? {}
                : {
                    integrationBinding: {
                      slot: binding.slot,
                      injectAs: binding.injectAs,
                    },
                  }),
            };
          },
        },
        runtimes,
        inputs: {
          async publish(input) {
            const bytes = new TextEncoder().encode(JSON.stringify(input.arguments));
            const id = stableId(
              input.runId,
              input.stateId,
              "arguments",
              createHash("sha256").update(bytes).digest("hex")
            );
            await options.artifacts.publishFile({
              id,
              bytes,
              mediaType: "application/json",
              fileName: "input.json",
              ...fileMetadata(context),
            });
            return artifactRef(id);
          },
        },
        credentials: leases,
        outputs: {
          async readJson(ref) {
            const text = new TextDecoder().decode((await bridge.read(ref)).bytes);
            return JSON.parse(text) as unknown;
          },
        },
        executor: coordinator,
        now: () => now().getTime(),
      })
    );
  }
  return adapters;
}
