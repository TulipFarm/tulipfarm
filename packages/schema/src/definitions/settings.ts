import { type Static, Type } from "@sinclair/typebox";
import {
  DEFINITION_API_VERSION,
  type DefinitionMetadata,
  definitionMetadataSchema,
  definitionRegistration,
} from "./common";

const apiVersion = DEFINITION_API_VERSION;
const MetadataSchema = Type.Unsafe<DefinitionMetadata>(definitionMetadataSchema);

export const ApprovalCategorySettingsSchema = Type.Object(
  {
    soulChange: Type.Boolean({ default: true }),
    highRiskAction: Type.Boolean({ default: true }),
    destructiveAction: Type.Boolean({ default: true }),
    protectedDataEgress: Type.Boolean({ default: true }),
    credentialUse: Type.Boolean({ default: true }),
  },
  { additionalProperties: false }
);

export const SettingsSchema = Type.Object(
  {
    apiVersion: Type.Literal(apiVersion),
    kind: Type.Literal("Settings"),
    metadata: MetadataSchema,
    spec: Type.Object(
      { approvalCategories: ApprovalCategorySettingsSchema },
      { additionalProperties: false }
    ),
  },
  { $id: `${apiVersion}/Settings`, additionalProperties: false }
);
export const SETTINGS_DEFINITION = definitionRegistration("Settings", SettingsSchema);

export type ApprovalCategorySettings = Static<typeof ApprovalCategorySettingsSchema>;
export type SettingsDefinition = Static<typeof SettingsSchema>;
