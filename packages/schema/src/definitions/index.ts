import type { SchemaRegistration } from "../registry";
import { AGENT_DEFINITION } from "./agent";
import { FORM_DEFINITION } from "./form";
import { GUARDRAIL_DEFINITION } from "./guardrail";
import {
  ACCESS_GRANT_DEFINITION,
  APP_DEFINITION,
  INTEGRATION_ADAPTER_DEFINITION,
  INTEGRATION_DEFINITION,
} from "./integration";
import { KNOWLEDGE_SOURCE_DEFINITION } from "./knowledge";
import { MEMORY_SETTINGS_DEFINITION } from "./memory";
import { MODEL_PROFILE_DEFINITION } from "./model";
import { ROLE_DEFINITION } from "./role";
import { ROUTINE_DEFINITION } from "./routine";
import { SETTINGS_DEFINITION } from "./settings";
import { SKILL_DEFINITION } from "./skill";
import { TOOL_CONTRACT_DEFINITION } from "./tool";
import { TRIGGER_DEFINITION } from "./trigger";

export {
  AGENT_DEFINITION,
  type AgentDefinition,
  AgentDefinitionSchema,
  type AgentSpec,
} from "./agent";
export * from "./common";
export * from "./form";
export * from "./guardrail";
export * from "./integration";
export * from "./knowledge";
export * from "./memory";
export {
  MODEL_PROFILE_DEFINITION,
  MODEL_PROFILE_DENIAL_REASONS,
  type ModelProfileDefinition,
  ModelProfileDefinitionSchema,
  type ModelProfileDenialReason,
  type ModelProfileSpec,
} from "./model";
export * from "./role";
export * from "./settings";
export {
  SKILL_DEFINITION,
  SKILL_FORBIDDEN_GRANT_KEYS,
  type SkillCommand,
  type SkillCommandFileOutput,
  type SkillCommandIntegrationBinding,
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
  ROUTINE_DEFINITION,
  TRIGGER_DEFINITION,
  ROLE_DEFINITION,
  GUARDRAIL_DEFINITION,
  SETTINGS_DEFINITION,
  INTEGRATION_ADAPTER_DEFINITION,
  APP_DEFINITION,
  INTEGRATION_DEFINITION,
  ACCESS_GRANT_DEFINITION,
  KNOWLEDGE_SOURCE_DEFINITION,
  MEMORY_SETTINGS_DEFINITION,
  FORM_DEFINITION,
];

/** Canonical `kind` discriminators. */
export const DEFINITION_KINDS = [
  "Agent",
  "Skill",
  "ToolContract",
  "ModelProfile",
  "Routine",
  "Trigger",
  "Role",
  "Guardrail",
  "Settings",
  "IntegrationAdapter",
  "App",
  "Integration",
  "AccessGrant",
  "KnowledgeSource",
  "MemorySettings",
  "Form",
] as const;
export type DefinitionKind = (typeof DEFINITION_KINDS)[number];

export * as event from "./event";
export * as routine from "./routine";
export * as trigger from "./trigger";
