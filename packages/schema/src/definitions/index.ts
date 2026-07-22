import type { SchemaRegistration } from "../registry";
import { AGENT_DEFINITION } from "./agent";
import { MODEL_PROFILE_DEFINITION } from "./model";
import { SKILL_DEFINITION } from "./skill";
import { TOOL_CONTRACT_DEFINITION } from "./tool";

export {
  AGENT_DEFINITION,
  type AgentDefinition,
  AgentDefinitionSchema,
  type AgentSpec,
} from "./agent";
export * from "./common";
export {
  MODEL_PROFILE_DEFINITION,
  type ModelProfileDefinition,
  ModelProfileDefinitionSchema,
  type ModelProfileSpec,
} from "./model";
export {
  SKILL_DEFINITION,
  SKILL_FORBIDDEN_GRANT_KEYS,
  type SkillDefinition,
  SkillDefinitionSchema,
  type SkillSpec,
} from "./skill";
export {
  TOOL_CONTRACT_DEFINITION,
  type ToolContractDefinition,
  ToolContractDefinitionSchema,
  type ToolContractSpec,
} from "./tool";

/** Every canonical authored-definition registration, in a stable order. */
export const DEFINITION_REGISTRATIONS: readonly SchemaRegistration[] = [
  AGENT_DEFINITION,
  SKILL_DEFINITION,
  TOOL_CONTRACT_DEFINITION,
  MODEL_PROFILE_DEFINITION,
];

/** Canonical `kind` discriminators owned by AW-008. */
export const DEFINITION_KINDS = ["Agent", "Skill", "ToolContract", "ModelProfile"] as const;
export type DefinitionKind = (typeof DEFINITION_KINDS)[number];
