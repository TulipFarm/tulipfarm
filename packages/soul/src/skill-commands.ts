import type { SkillCommand, SkillDefinition, ToolContractDefinition } from "@tulipfarm/schema";
import type { BundleAsset, BundleDefinition, RuntimeBundle } from "./bundle";

export type RuntimeSkillCommandErrorCode =
  | "command_asset_missing"
  | "command_binding_invalid"
  | "command_tool_missing";

export class RuntimeSkillCommandError extends Error {
  constructor(
    readonly code: RuntimeSkillCommandErrorCode,
    readonly skillId: string,
    readonly commandName: string
  ) {
    super(`${code}:${skillId}:${commandName}`);
    this.name = "RuntimeSkillCommandError";
  }
}

export interface RuntimeSkillCommand {
  readonly skillId: string;
  readonly skillSlug: string;
  readonly skillVersion: number;
  readonly bundleDigest: string;
  readonly command: SkillCommand;
  readonly tool: ToolContractDefinition;
  readonly entrypoint: BundleAsset;
  readonly assets: readonly BundleAsset[];
}

function toolDefinition(bundle: RuntimeBundle, ref: string): BundleDefinition | undefined {
  const byId = bundle.getById(ref);
  if (byId?.kind === "ToolContract") return byId;
  return bundle.get("ToolContract", ref);
}

export function resolveRuntimeSkillCommands(bundle: RuntimeBundle): readonly RuntimeSkillCommand[] {
  const commands: RuntimeSkillCommand[] = [];
  for (const definition of bundle.definitions) {
    if (definition.kind !== "Skill") continue;
    const skill = definition.document as unknown as SkillDefinition;
    for (const command of skill.spec.commands ?? []) {
      const toolBundle = toolDefinition(bundle, command.toolRef);
      if (toolBundle === undefined) {
        throw new RuntimeSkillCommandError("command_tool_missing", skill.metadata.id, command.name);
      }
      const tool = toolBundle.document as unknown as ToolContractDefinition;
      if (
        tool.spec.adapter.kind !== "sandbox" ||
        tool.spec.adapter.ref !== `skill:${skill.metadata.slug}/${command.name}`
      ) {
        throw new RuntimeSkillCommandError(
          "command_binding_invalid",
          skill.metadata.id,
          command.name
        );
      }
      const entrypoint = bundle.asset(skill.metadata.id, command.entrypoint);
      if (entrypoint === undefined) {
        throw new RuntimeSkillCommandError(
          "command_asset_missing",
          skill.metadata.id,
          command.name
        );
      }
      commands.push(
        Object.freeze({
          skillId: skill.metadata.id,
          skillSlug: skill.metadata.slug,
          skillVersion: skill.metadata.authoredVersion,
          bundleDigest: bundle.digest,
          command: Object.freeze(structuredClone(command)),
          tool,
          entrypoint,
          assets: Object.freeze(
            bundle.assets.filter((asset) => asset.ownerDefinitionId === skill.metadata.id)
          ),
        })
      );
    }
  }
  return Object.freeze(commands);
}
