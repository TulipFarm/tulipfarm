import type {
  SandboxComputeLimits,
  SandboxCredentialBinding,
  SandboxExecutionRequest,
  SandboxExecutionResult,
  SandboxFileOutputDeclaration,
} from "./request";

export type SkillExecutionErrorCode =
  | "asset_digest_mismatch"
  | "asset_not_scanned"
  | "cleanup_failed"
  | "direct_network_forbidden"
  | "git_grant_denied"
  | "git_revision_not_pinned"
  | "invalid_skill_bundle"
  | "output_rejected"
  | "sandbox_execution_failed"
  | "undeclared_asset"
  | "unsafe_artifact_ref"
  | "unsafe_asset_path"
  | "web_destination_denied";

const ERROR_MESSAGES: Readonly<Record<SkillExecutionErrorCode, string>> = {
  asset_digest_mismatch: "Skill asset digest does not match the published bundle",
  asset_not_scanned: "Skill asset has not passed scanning",
  cleanup_failed: "Skill execution cleanup failed",
  direct_network_forbidden: "Skill contains an unmediated network mutation",
  git_grant_denied: "Git target access was denied",
  git_revision_not_pinned: "Git target revision is not immutable",
  invalid_skill_bundle: "Skill bundle is invalid",
  output_rejected: "Skill output was rejected by scanning",
  sandbox_execution_failed: "Skill sandbox execution failed",
  undeclared_asset: "Skill asset is not declared by the published bundle",
  unsafe_artifact_ref: "Skill Artifact reference is unsafe",
  unsafe_asset_path: "Skill asset path is unsafe",
  web_destination_denied: "Skill web destination was denied",
};

export class SkillExecutionError extends Error {
  constructor(readonly code: SkillExecutionErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "SkillExecutionError";
  }
}

export interface SkillBundleAsset {
  readonly path: string;
  readonly digest: string;
}

export interface SkillGitTarget {
  readonly repositoryId: string;
  readonly revision: string;
}

export interface PinnedSkillBundle {
  readonly skillId: string;
  readonly version: string;
  readonly digest: string;
  readonly entrypoint: SkillBundleAsset;
  readonly assets: readonly SkillBundleAsset[];
  /** Guardrail-owned identifiers whose backend policies mediate the actual web request. */
  readonly webDestinationIds: readonly string[];
  readonly gitTargets: readonly SkillGitTarget[];
}

export interface SkillExecutionInput {
  readonly requestId: string;
  readonly nonce: string;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
  readonly bundle: PinnedSkillBundle;
  readonly requestedAssetPaths: readonly string[];
  /** Immutable Run input Artifacts, including the broker-serialized JSON Tool arguments. */
  readonly inputArtifactRefs?: readonly string[];
  readonly argv: readonly string[];
  readonly compute: SandboxComputeLimits;
  readonly workspaceMaxBytes: number;
  readonly web: {
    readonly destinationIds: readonly string[];
    readonly maxBytes: number;
  };
  readonly gitTargets: readonly SkillGitTarget[];
  /** Present only after a sandbox ToolContract has been authorized and its effect reserved. */
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

export type SkillScanFinding = "direct_network_mutation";

export interface ResolvedSkillArtifact {
  readonly artifactRef: string;
  readonly digest: string;
  readonly scan: {
    readonly verdict: "clean" | "rejected";
    readonly findings: readonly SkillScanFinding[];
  };
}

export interface SkillArtifactResolver {
  /**
   * Resolve an immutable Artifact from the published bundle. Implementations materialize it
   * read-only in the backend; this boundary never accepts host paths or mutable file handles.
   */
  resolve(input: {
    readonly bundleDigest: string;
    readonly path: string;
    readonly expectedDigest: string;
  }): Promise<ResolvedSkillArtifact>;
}

export interface SkillSandboxExecutor {
  execute(request: SandboxExecutionRequest): Promise<SandboxExecutionResult>;
}

export interface SkillOutputScan {
  readonly verdict: "clean" | "rejected";
  readonly scanId: string;
}

export interface SkillOutputScanner {
  scan(input: {
    readonly requestId: string;
    readonly stdoutArtifactRef: string;
    readonly stderrArtifactRef: string;
    readonly outputArtifactRefs?: readonly string[];
  }): Promise<SkillOutputScan>;
}

export interface PublishedSkillOutput {
  readonly artifactId: string;
  readonly artifactRef: string;
}

export interface SkillOutputPublisher {
  publish(input: {
    readonly requestId: string;
    readonly scanId: string;
    readonly stdoutArtifactRef: string;
    readonly stderrArtifactRef: string;
    readonly jsonArtifactRef?: string;
    readonly fileArtifactRefs?: readonly string[];
  }): Promise<PublishedSkillOutput>;
}

export type SkillGitLockDecision =
  | {
      readonly granted: true;
      readonly lockId: string;
      /** Immutable snapshot exposed to the sandbox as an Artifact, never a host mount. */
      readonly workspaceArtifactRef: string;
    }
  | { readonly granted: false };

export interface SkillGitLockPort {
  lockGrantedTarget(input: {
    readonly requestId: string;
    readonly repositoryId: string;
    readonly revision: string;
  }): Promise<SkillGitLockDecision>;
  release(lockId: string): Promise<void>;
}

export interface SkillExecutionCoordinatorDeps {
  readonly assets: SkillArtifactResolver;
  readonly sandbox: SkillSandboxExecutor;
  readonly outputScanner: SkillOutputScanner;
  readonly outputPublisher: SkillOutputPublisher;
  readonly gitLocks: SkillGitLockPort;
}

export interface SkillExecutionOutcome {
  readonly sandboxResult: SandboxExecutionResult;
  readonly outputArtifact: PublishedSkillOutput;
}

// Execution Bundles and their assets use the repository-wide raw SHA-256 hex form; backend image
// identities use the OCI `sha256:` prefix. Both are immutable SHA-256 identities.
const DIGEST_PATTERN = /^(?:sha256:)?[0-9a-f]{64}$/;
const GIT_REVISION_PATTERN = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const DESTINATION_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const ARTIFACT_REF_PATTERN =
  /^artifact:\/\/[a-zA-Z0-9][a-zA-Z0-9._-]*(\/[a-zA-Z0-9][a-zA-Z0-9._-]*)*$/;

function assertSafeAssetPath(path: string): void {
  const segments = path.split("/");
  if (
    path.length === 0 ||
    path.length > 512 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new SkillExecutionError("unsafe_asset_path");
  }
}

function assertBundle(bundle: PinnedSkillBundle): void {
  if (
    bundle.skillId.length === 0 ||
    bundle.version.length === 0 ||
    !DIGEST_PATTERN.test(bundle.digest) ||
    !DIGEST_PATTERN.test(bundle.entrypoint.digest) ||
    bundle.assets.some((asset) => !DIGEST_PATTERN.test(asset.digest)) ||
    bundle.webDestinationIds.some((id) => !DESTINATION_ID_PATTERN.test(id))
  ) {
    throw new SkillExecutionError("invalid_skill_bundle");
  }
  assertSafeAssetPath(bundle.entrypoint.path);
  for (const asset of bundle.assets) {
    assertSafeAssetPath(asset.path);
  }
  const paths = [bundle.entrypoint.path, ...bundle.assets.map((asset) => asset.path)];
  if (new Set(paths).size !== paths.length) {
    throw new SkillExecutionError("invalid_skill_bundle");
  }
}

function declarationFor(bundle: PinnedSkillBundle, path: string): SkillBundleAsset {
  assertSafeAssetPath(path);
  const declaration = bundle.assets.find((asset) => asset.path === path);
  if (!declaration) {
    throw new SkillExecutionError("undeclared_asset");
  }
  return declaration;
}

function assertWebAccess(bundle: PinnedSkillBundle, destinationIds: readonly string[]): void {
  const allowed = new Set(bundle.webDestinationIds);
  if (
    new Set(destinationIds).size !== destinationIds.length ||
    destinationIds.some(
      (destinationId) => !DESTINATION_ID_PATTERN.test(destinationId) || !allowed.has(destinationId)
    )
  ) {
    throw new SkillExecutionError("web_destination_denied");
  }
}

function assertGitTarget(bundle: PinnedSkillBundle, target: SkillGitTarget): void {
  if (!GIT_REVISION_PATTERN.test(target.revision)) {
    throw new SkillExecutionError("git_revision_not_pinned");
  }
  const declared = bundle.gitTargets.some(
    (candidate) =>
      candidate.repositoryId === target.repositoryId && candidate.revision === target.revision
  );
  if (!declared) {
    throw new SkillExecutionError("git_grant_denied");
  }
}

function assertResolvedArtifact(
  artifact: ResolvedSkillArtifact,
  expectedDigest: string,
  allowDeclaredNetwork: boolean
): void {
  if (!ARTIFACT_REF_PATTERN.test(artifact.artifactRef)) {
    throw new SkillExecutionError("unsafe_artifact_ref");
  }
  if (artifact.digest !== expectedDigest) {
    throw new SkillExecutionError("asset_digest_mismatch");
  }
  if (artifact.scan.verdict !== "clean") {
    throw new SkillExecutionError("asset_not_scanned");
  }
  if (!allowDeclaredNetwork && artifact.scan.findings.includes("direct_network_mutation")) {
    throw new SkillExecutionError("direct_network_forbidden");
  }
}

async function releaseLocks(
  gitLocks: SkillGitLockPort,
  lockIds: readonly string[]
): Promise<boolean> {
  let clean = true;
  for (const lockId of [...lockIds].reverse()) {
    try {
      await gitLocks.release(lockId);
    } catch {
      clean = false;
    }
  }
  return clean;
}

export class SkillExecutionCoordinator {
  constructor(private readonly deps: SkillExecutionCoordinatorDeps) {}

  async execute(input: SkillExecutionInput): Promise<SkillExecutionOutcome> {
    assertBundle(input.bundle);
    assertWebAccess(input.bundle, input.web.destinationIds);

    const requestedDeclarations = input.requestedAssetPaths.map((path) =>
      declarationFor(input.bundle, path)
    );
    if (new Set(input.requestedAssetPaths).size !== input.requestedAssetPaths.length) {
      throw new SkillExecutionError("invalid_skill_bundle");
    }
    for (const target of input.gitTargets) {
      assertGitTarget(input.bundle, target);
    }

    const entrypoint = await this.deps.assets.resolve({
      bundleDigest: input.bundle.digest,
      path: input.bundle.entrypoint.path,
      expectedDigest: input.bundle.entrypoint.digest,
    });
    assertResolvedArtifact(
      entrypoint,
      input.bundle.entrypoint.digest,
      input.web.destinationIds.length > 0
    );

    const inputArtifactRefs: string[] = [];
    for (const artifactRef of input.inputArtifactRefs ?? []) {
      if (!ARTIFACT_REF_PATTERN.test(artifactRef)) {
        throw new SkillExecutionError("unsafe_artifact_ref");
      }
      inputArtifactRefs.push(artifactRef);
    }
    for (const declaration of requestedDeclarations) {
      const artifact = await this.deps.assets.resolve({
        bundleDigest: input.bundle.digest,
        path: declaration.path,
        expectedDigest: declaration.digest,
      });
      assertResolvedArtifact(artifact, declaration.digest, false);
      inputArtifactRefs.push(artifact.artifactRef);
    }

    const lockIds: string[] = [];
    let execution:
      | { readonly succeeded: true; readonly outcome: SkillExecutionOutcome }
      | { readonly succeeded: false; readonly error: unknown };
    try {
      for (const target of input.gitTargets) {
        const decision = await this.deps.gitLocks.lockGrantedTarget({
          requestId: input.requestId,
          repositoryId: target.repositoryId,
          revision: target.revision,
        });
        if (!decision.granted) {
          throw new SkillExecutionError("git_grant_denied");
        }
        if (!ARTIFACT_REF_PATTERN.test(decision.workspaceArtifactRef)) {
          throw new SkillExecutionError("unsafe_artifact_ref");
        }
        lockIds.push(decision.lockId);
        inputArtifactRefs.push(decision.workspaceArtifactRef);
      }

      let sandboxResult: SandboxExecutionResult;
      try {
        const toolFields =
          input.runtimeProfile === undefined
            ? {}
            : {
                runtimeProfile: input.runtimeProfile,
                credentialBindings: input.credentialBindings ?? [],
                outputs: input.outputs ?? { jsonPath: "outputs/result.json", files: [] },
              };
        sandboxResult = await this.deps.sandbox.execute({
          requestId: input.requestId,
          nonce: input.nonce,
          issuedAtMs: input.issuedAtMs,
          expiresAtMs: input.expiresAtMs,
          operation: input.runtimeProfile === undefined ? "compute" : "tool",
          workspace: {
            kind: "ephemeral",
            maxBytes: input.workspaceMaxBytes,
          },
          entrypoint: {
            artifactRef: entrypoint.artifactRef,
            argv: input.argv,
          },
          inputArtifactRefs,
          compute: input.compute,
          egress: input.web,
          ...toolFields,
        });
      } catch {
        throw new SkillExecutionError("sandbox_execution_failed");
      }

      const outputArtifactRefs = sandboxResult.outputs
        ? [
            sandboxResult.outputs.jsonArtifactRef,
            ...sandboxResult.outputs.files.map((file) => file.artifactRef),
          ]
        : undefined;
      const scan = await this.deps.outputScanner.scan({
        requestId: input.requestId,
        stdoutArtifactRef: sandboxResult.stdoutArtifactRef,
        stderrArtifactRef: sandboxResult.stderrArtifactRef,
        ...(outputArtifactRefs === undefined ? {} : { outputArtifactRefs }),
      });
      if (scan.verdict !== "clean") {
        throw new SkillExecutionError("output_rejected");
      }
      const outputArtifact = await this.deps.outputPublisher.publish({
        requestId: input.requestId,
        scanId: scan.scanId,
        stdoutArtifactRef: sandboxResult.stdoutArtifactRef,
        stderrArtifactRef: sandboxResult.stderrArtifactRef,
        ...(sandboxResult.outputs === undefined
          ? {}
          : {
              jsonArtifactRef: sandboxResult.outputs.jsonArtifactRef,
              fileArtifactRefs: sandboxResult.outputs.files.map((file) => file.artifactRef),
            }),
      });
      execution = {
        succeeded: true,
        outcome: { sandboxResult, outputArtifact },
      };
    } catch (error) {
      execution = { succeeded: false, error };
    }

    const clean = await releaseLocks(this.deps.gitLocks, lockIds);
    if (!execution.succeeded) {
      throw execution.error;
    }
    if (!clean) {
      throw new SkillExecutionError("cleanup_failed");
    }
    return execution.outcome;
  }
}
