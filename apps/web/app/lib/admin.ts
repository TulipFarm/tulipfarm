import { apiCommand, apiGet } from "./api";

export type GuardrailItem = {
  id: string;
  name?: string;
  enabled?: boolean;
  effect?: string;
  scope?: string;
};

export type GuardrailsModel = {
  revision: string;
  items: GuardrailItem[];
};

export function getGuardrails(): Promise<GuardrailsModel> {
  return apiGet<GuardrailsModel>("/api/v1/guardrails");
}

export function proposeGuardrailToggle(
  model: GuardrailsModel,
  item: GuardrailItem,
  enabled: boolean
): Promise<{ changesetId: string; status: string }> {
  const index = model.items.findIndex((candidate) => candidate.id === item.id);
  return apiCommand(
    "/api/v1/guardrails/changesets",
    {
      baseRevision: model.revision,
      changes: [{ op: "replace", path: `/items/${index}/enabled`, value: enabled }],
    },
    `guardrail-${model.revision}-${item.id}-${enabled}`
  );
}

export type RolesModel = {
  revision: string;
  items: Array<{
    id: string;
    name: string;
    principalKinds: string[];
    grants: string[];
    conditions: string[];
  }>;
};

export function getRoles(): Promise<RolesModel> {
  return apiGet<RolesModel>("/api/v1/roles");
}
