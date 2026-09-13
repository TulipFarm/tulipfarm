import { oimPrincipalBody } from "@tulipfarm/schema";
import { readPointer } from "../egress/oim-pagination";
import type { KnowledgeItemFieldValue } from "./oim-mapping";
import type { KnowledgeProfilePlan } from "./oim-profile";
import type { OimKnowledgeApiPort } from "./oim-sync";

const MAX_LIVE_AUTHORIZATION_PAGES = 50;

export async function checkOimProviderAccess(
  plan: KnowledgeProfilePlan,
  api: OimKnowledgeApiPort,
  source: {
    readonly businessId: string;
    readonly itemId: string;
    readonly connectionId: string;
    readonly externalTenantId: string;
    readonly externalAccountId: string;
    readonly fields?: Readonly<Record<string, KnowledgeItemFieldValue>>;
  },
  externalSubject: string
): Promise<boolean | undefined> {
  if (
    api.connection.businessId !== source.businessId ||
    api.connection.integrationId !== plan.integrationId ||
    api.connection.integrationMajorVersion !== plan.majorVersion ||
    api.connection.connectionId !== source.connectionId ||
    api.connection.externalTenantId !== source.externalTenantId ||
    api.connection.externalAccountId !== source.externalAccountId
  ) {
    return undefined;
  }
  const live = plan.liveAuthorization;
  if (live === undefined || externalSubject.length === 0) return undefined;
  const parameters = fieldParameters(live.parameters, source.fields);
  if (parameters === undefined) return undefined;
  if (live.itemParameter !== undefined) parameters[live.itemParameter] = source.itemId;
  if (live.principalParameter !== undefined) {
    if (live.principalBody !== undefined) {
      const requestSchema = live.operation.requestSchema;
      if (requestSchema === undefined) return undefined;
      try {
        parameters[live.principalParameter] = oimPrincipalBody(
          live.principalBody,
          externalSubject,
          requestSchema
        );
      } catch {
        return undefined;
      }
    } else {
      parameters[live.principalParameter] = externalSubject;
    }
  }

  if (live.allowedPointer !== undefined) {
    try {
      const { body } = await api.execute({
        operationId: live.operation.id,
        parameters,
      });
      const allowed = readPointer(body, live.allowedPointer);
      return typeof allowed === "boolean" ? allowed : undefined;
    } catch {
      return undefined;
    }
  }

  const principalSet = live.principalSet;
  if (principalSet === undefined) return undefined;
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_LIVE_AUTHORIZATION_PAGES; page += 1) {
    let response: Awaited<ReturnType<OimKnowledgeApiPort["execute"]>>;
    try {
      response = await api.execute({
        operationId: live.operation.id,
        parameters,
        ...(pageToken === undefined ? {} : { pageToken }),
      });
    } catch {
      return undefined;
    }
    const entries = readPointer(response.body, principalSet.entriesPointer);
    if (!Array.isArray(entries)) return undefined;
    for (const entry of entries) {
      const providerId = readPointer(entry, principalSet.principalIdPointer);
      if (typeof providerId !== "string") return undefined;
      if (providerId === externalSubject) return true;
    }
    if (response.nextPageToken === undefined) return false;
    pageToken = response.nextPageToken;
  }
  return undefined;
}

function fieldParameters(
  bindings: Readonly<Record<string, string>> | undefined,
  fields: Readonly<Record<string, KnowledgeItemFieldValue>> | undefined
): Record<string, unknown> | undefined {
  const parameters: Record<string, unknown> = {};
  for (const [name, field] of Object.entries(bindings ?? {})) {
    if (fields === undefined || !Object.hasOwn(fields, field)) return undefined;
    const value = fields[field];
    if (
      typeof value !== "string" &&
      typeof value !== "boolean" &&
      (typeof value !== "number" || !Number.isFinite(value))
    ) {
      return undefined;
    }
    parameters[name] = value;
  }
  return parameters;
}
