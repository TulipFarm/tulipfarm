import { randomUUID } from "node:crypto";
import type { ArtifactService } from "@tulipfarm/run-kernel";
import type { RuntimeBundle } from "@tulipfarm/soul";
import { resolveRuntimeSkillCommands } from "@tulipfarm/soul";
import { buildBundleSandboxAdapters } from "./sandbox-tooling";

export type SkillCommandRunErrorCode =
  | "sandbox_unavailable"
  | "skill_not_found"
  | "command_not_found"
  | "destination_denied";

export class SkillCommandRunError extends Error {
  /**
   * @param available What the caller could have named instead. A model that guessed a Skill or
   * command name cannot recover from a bare refusal, so a name-resolution failure carries the
   * real options rather than making the model call a second Tool to discover them.
   */
  constructor(
    readonly code: SkillCommandRunErrorCode,
    readonly available: readonly string[] = []
  ) {
    super(code);
    this.name = "SkillCommandRunError";
  }
}

export interface SkillCommandDescriptor {
  readonly skill: string;
  readonly command: string;
  readonly runtimeProfile: string;
  readonly entrypoint: string;
  readonly allowedDestinations: readonly string[];
}

export interface SkillCommandRunRequest {
  readonly businessId: string;
  readonly runId: string;
  readonly stateKey: string;
  readonly skill: string;
  readonly command: string;
  readonly arguments?: Record<string, unknown>;
  /** Named egress destination; refused unless the command's ToolContract already allows it. */
  readonly destination?: string;
}

export interface SkillCommandRunResult {
  readonly skill: string;
  readonly command: string;
  readonly output: unknown;
}

export interface SkillCommandRunnerOptions {
  readonly artifacts: ArtifactService;
  /** The verified bundle a call executes against; `undefined` before the first publication. */
  readonly bundle: () => Promise<RuntimeBundle | undefined>;
  /** Development-only immutable `repository@sha256:...` reference; absent disables execution. */
  readonly runtimeImage?: string;
  readonly now?: () => Date;
}

/**
 * Runs one declared Skill command in the same sandbox a Routine `tool` State uses.
 *
 * Skills are instruction packages, so a Skill's own code is inert until something executes it.
 * Without this a Chat Agent can only read a command's source into its prompt and describe what it
 * would print, which diverges from what the code actually does the moment it reads a clock, a
 * random value, a file or the network.
 */
export class SkillCommandRunner {
  constructor(private readonly options: SkillCommandRunnerOptions) {}

  /** Every command a Chat Agent may run right now, so the model names one instead of guessing. */
  async list(): Promise<readonly SkillCommandDescriptor[]> {
    if (this.options.runtimeImage === undefined) return [];
    const bundle = await this.options.bundle();
    if (bundle === undefined) return [];
    return resolveRuntimeSkillCommands(bundle).map((resolved) => ({
      skill: resolved.skillSlug,
      command: resolved.command.name,
      runtimeProfile: resolved.command.runtimeProfile,
      entrypoint: resolved.entrypoint.path,
      allowedDestinations: resolved.tool.spec.allowedDestinations ?? [],
    }));
  }

  async run(request: SkillCommandRunRequest): Promise<SkillCommandRunResult> {
    if (this.options.runtimeImage === undefined) {
      throw new SkillCommandRunError("sandbox_unavailable");
    }
    const bundle = await this.options.bundle();
    if (bundle === undefined) throw new SkillCommandRunError("sandbox_unavailable");

    const commands = resolveRuntimeSkillCommands(bundle);
    if (!commands.some((candidate) => candidate.skillSlug === request.skill)) {
      throw new SkillCommandRunError("skill_not_found", [
        ...new Set(commands.map((candidate) => candidate.skillSlug)),
      ]);
    }
    const resolved = commands.find(
      (candidate) =>
        candidate.skillSlug === request.skill && candidate.command.name === request.command
    );
    if (resolved === undefined) {
      throw new SkillCommandRunError(
        "command_not_found",
        commands
          .filter((candidate) => candidate.skillSlug === request.skill)
          .map((candidate) => candidate.command.name)
      );
    }

    // The contract, not the caller, decides where a command may reach. Checking here keeps the
    // refusal a named error instead of a sandbox guardrail fault the model cannot act on.
    const allowed = resolved.tool.spec.allowedDestinations ?? [];
    if (request.destination !== undefined && !allowed.includes(request.destination)) {
      throw new SkillCommandRunError("destination_denied", allowed);
    }

    const adapters = buildBundleSandboxAdapters(
      {
        businessId: request.businessId,
        runId: request.runId,
        stateKey: request.stateKey,
        bundle,
      },
      {
        artifacts: this.options.artifacts,
        runtimeImage: this.options.runtimeImage,
        ...(this.options.now === undefined ? {} : { now: this.options.now }),
      }
    );
    const adapter = adapters.get(resolved.tool.spec.adapter.ref);
    if (adapter === undefined) throw new SkillCommandRunError("command_not_found");

    const idempotencyKey = `skill-command:${request.runId}:${request.stateKey}:${randomUUID()}`;
    const output = await adapter.dispatch({
      intent: {
        intentId: randomUUID(),
        businessId: request.businessId,
        runId: request.runId,
        stateId: request.stateKey,
        toolId: resolved.tool.spec.toolId,
        toolVersion: resolved.tool.spec.toolVersion,
        action: resolved.tool.spec.action,
        targetRefs: [],
        arguments: request.arguments ?? {},
        ...(request.destination === undefined ? {} : { destination: request.destination }),
        idempotencyKey,
      },
      idempotencyKey,
      attempt: 1,
    });
    return { skill: request.skill, command: request.command, output };
  }
}
