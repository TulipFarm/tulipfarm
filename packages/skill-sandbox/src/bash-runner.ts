import { createHash, randomUUID } from "node:crypto";
import type { ArtifactService } from "@tulipfarm/run-kernel";
import type { RuntimeBundle } from "@tulipfarm/soul";
import { type BashCommandResult, buildBashScript } from "./bash-script";
import { type CommandRefusalReason, decideCommand } from "./command-allowlist";
import { createSandboxStack, SANDBOX_LIMITS } from "./sandbox-tooling";

/** Path of the generated entrypoint inside the Execution Bundle; never a real bundle asset. */
const INLINE_ENTRYPOINT = "tulip-inline-command.sh";

export type SkillBashRunErrorCode =
  | "sandbox_unavailable"
  | "skill_not_found"
  | "command_refused"
  | "destination_denied";

export class SkillBashRunError extends Error {
  /**
   * @param reason Why the allowlist refused, when it did — the model cannot correct a command it
   * is only told was rejected.
   * @param available The Skill's declared patterns or destinations, so a refusal names what the
   * caller could legitimately have asked for instead.
   */
  constructor(
    readonly code: SkillBashRunErrorCode,
    readonly available: readonly string[] = [],
    readonly reason?: CommandRefusalReason
  ) {
    super(code);
    this.name = "SkillBashRunError";
  }
}

export interface SkillBashRunRequest {
  readonly businessId: string;
  readonly runId: string;
  readonly stateKey: string;
  /** Slug of the Skill whose `allowedCommands` authorize this command. */
  readonly skill: string;
  readonly command: string;
  /** Patterns from the Skill's frontmatter; an empty list refuses everything. */
  readonly allowedCommands: readonly string[];
  /** Destinations the Skill already declares on its commands; the ceiling for `destination`. */
  readonly allowedDestinations?: readonly string[];
  readonly destination?: string;
}

export interface SkillBashRunResult extends BashCommandResult {
  readonly skill: string;
  readonly command: string;
  readonly matchedPattern: string;
}

export interface SkillBashRunnerOptions {
  readonly artifacts: ArtifactService;
  readonly bundle: () => Promise<RuntimeBundle | undefined>;
  /** Development-only immutable `repository@sha256:...` reference; absent disables execution. */
  readonly runtimeImage?: string;
  readonly now?: () => Date;
}

function parseResult(text: string): BashCommandResult {
  const parsed = JSON.parse(text) as Partial<BashCommandResult>;
  if (
    typeof parsed.exitCode !== "number" ||
    typeof parsed.stdout !== "string" ||
    typeof parsed.stderr !== "string"
  ) {
    throw new Error("sandbox_result_malformed");
  }
  return {
    exitCode: parsed.exitCode,
    stdout: parsed.stdout,
    stderr: parsed.stderr,
    truncated: parsed.truncated === true,
  };
}

/**
 * Run a shell command a Skill's `SKILL.md` documented but never packaged as a file.
 *
 * The command arrives as model input, so unlike {@link SkillCommandRunner} it cannot be resolved
 * from a ToolContract. Two things stand in for that: the Skill's `allowedCommands` patterns decide
 * whether the command may run at all, and the sandbox — read-only, non-root, `--network=none`
 * unless a destination was declared — decides what it can reach once it does. The allowlist states
 * intent; the sandbox is the containment.
 */
export class SkillBashRunner {
  constructor(private readonly options: SkillBashRunnerOptions) {}

  async run(request: SkillBashRunRequest): Promise<SkillBashRunResult> {
    const decision = decideCommand(request.command, request.allowedCommands);
    if (!decision.allowed) {
      throw new SkillBashRunError("command_refused", request.allowedCommands, decision.reason);
    }

    const allowedDestinations = request.allowedDestinations ?? [];
    if (request.destination !== undefined && !allowedDestinations.includes(request.destination)) {
      throw new SkillBashRunError("destination_denied", allowedDestinations);
    }

    const bundle = await this.options.bundle();
    if (bundle === undefined) throw new SkillBashRunError("sandbox_unavailable");

    const script = buildBashScript(request.command);
    const digest = createHash("sha256").update(script, "utf8").digest("hex");
    const stack = createSandboxStack(
      { ...request, bundle },
      {
        artifacts: this.options.artifacts,
        ...(this.options.runtimeImage === undefined
          ? {}
          : { runtimeImage: this.options.runtimeImage }),
        ...(this.options.now === undefined ? {} : { now: this.options.now }),
      },
      {
        allowedEgressDestinationIds: () => allowedDestinations,
        syntheticAssets: new Map([[INLINE_ENTRYPOINT, script]]),
      }
    );
    if (stack === undefined) throw new SkillBashRunError("sandbox_unavailable");

    const issuedAtMs = stack.now().getTime();
    const destinationIds = request.destination === undefined ? [] : [request.destination];
    const outcome = await stack.coordinator.execute({
      requestId: randomUUID(),
      nonce: randomUUID(),
      issuedAtMs,
      expiresAtMs: issuedAtMs + SANDBOX_LIMITS.requestLifetimeMs,
      bundle: {
        skillId: request.skill,
        version: bundle.digest,
        digest: bundle.digest,
        entrypoint: { path: INLINE_ENTRYPOINT, digest },
        assets: [],
        webDestinationIds: destinationIds,
        gitTargets: [],
      },
      requestedAssetPaths: [],
      argv: [],
      compute: {
        timeoutMs: SANDBOX_LIMITS.timeoutMs,
        cpuMillis: SANDBOX_LIMITS.timeoutMs,
        memoryBytes: SANDBOX_LIMITS.memoryBytes,
        outputBytes: SANDBOX_LIMITS.outputBytes,
      },
      workspaceMaxBytes: SANDBOX_LIMITS.workspaceBytes,
      // A zero cap is what "no network" means to the guardrail; naming a byte budget with no
      // destination is rejected as an egress request that names nowhere to go.
      web: {
        destinationIds,
        maxBytes: destinationIds.length === 0 ? 0 : SANDBOX_LIMITS.egressBytes,
      },
      gitTargets: [],
      runtimeProfile: { id: stack.runtimeProfileId, imageDigest: stack.imageDigest },
      outputs: { jsonPath: "result.json", files: [] },
    });

    const bytes = (await stack.bridge.read(outcome.outputArtifact.artifactRef)).bytes;
    return {
      skill: request.skill,
      command: request.command,
      matchedPattern: decision.matchedPattern,
      ...parseResult(new TextDecoder().decode(bytes)),
    };
  }
}
