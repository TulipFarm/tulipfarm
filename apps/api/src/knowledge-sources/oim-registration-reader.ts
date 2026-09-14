import type { Queryable } from "../db";
import type { PersistedOimKnowledgeRegistration } from "../internal/oim-worker-host";

interface RegistrationRow {
  readonly business_id: string;
  readonly integration_id: string;
  readonly source_locator: unknown;
  readonly classification: string[];
  readonly access_control_mode: string;
  readonly access_control_max_age_seconds: number;
}

interface OimSourceLocator {
  readonly kind: "oim";
  readonly integrationSlug: string;
  readonly integrationId: string;
  readonly integrationMajorVersion: number;
  readonly connectionId: string;
  readonly sourceKindId: string;
  readonly scope: string;
}

function locator(value: unknown): OimSourceLocator | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (
    row.kind !== "oim" ||
    typeof row.integrationSlug !== "string" ||
    typeof row.integrationId !== "string" ||
    !Number.isSafeInteger(row.integrationMajorVersion) ||
    typeof row.connectionId !== "string" ||
    typeof row.sourceKindId !== "string" ||
    typeof row.scope !== "string"
  ) {
    return null;
  }
  return row as unknown as OimSourceLocator;
}

interface MutableRegistration {
  readonly businessId: string;
  readonly integrationSlug: string;
  readonly connectionId: string;
  readonly integrationId: string;
  readonly integrationMajorVersion: number;
  readonly sourceKindId: string;
  readonly scopes: Set<string>;
  readonly classification: Set<string>;
  aclMaximumAgeSeconds?: number;
  liveMaximumAgeSeconds?: number;
}

function minimum(current: number | undefined, candidate: number): number {
  return current === undefined ? candidate : Math.min(current, candidate);
}

export class PgOimKnowledgeRegistrationReader {
  constructor(private readonly queryable: Queryable) {}

  async list(): Promise<readonly PersistedOimKnowledgeRegistration[]> {
    const result = await this.queryable.query<RegistrationRow>(
      `SELECT business_id, integration_id, source_locator, classification,
              access_control_mode, access_control_max_age_seconds
         FROM knowledge_source_records
        WHERE status = 'active'
          AND source_locator ->> 'kind' = 'oim'
        ORDER BY business_id, integration_id, source_id`
    );
    const registrations = new Map<string, MutableRegistration>();
    for (const row of result.rows) {
      const source = locator(row.source_locator);
      if (source === null || source.integrationId !== row.integration_id) continue;
      const key = [
        row.business_id,
        source.integrationSlug,
        source.connectionId,
        source.integrationId,
        source.integrationMajorVersion,
        source.sourceKindId,
      ].join("\0");
      const registration = registrations.get(key) ?? {
        businessId: row.business_id,
        integrationSlug: source.integrationSlug,
        connectionId: source.connectionId,
        integrationId: source.integrationId,
        integrationMajorVersion: source.integrationMajorVersion,
        sourceKindId: source.sourceKindId,
        scopes: new Set<string>(),
        classification: new Set<string>(),
      };
      registration.scopes.add(source.scope);
      for (const classification of row.classification) {
        registration.classification.add(classification);
      }
      if (row.access_control_mode === "snapshot") {
        registration.aclMaximumAgeSeconds = minimum(
          registration.aclMaximumAgeSeconds,
          row.access_control_max_age_seconds
        );
      } else if (row.access_control_mode === "live") {
        registration.liveMaximumAgeSeconds = minimum(
          registration.liveMaximumAgeSeconds,
          row.access_control_max_age_seconds
        );
      }
      registrations.set(key, registration);
    }
    return [...registrations.values()].map((registration) => ({
      businessId: registration.businessId,
      integrationSlug: registration.integrationSlug,
      connectionId: registration.connectionId,
      integrationId: registration.integrationId,
      integrationMajorVersion: registration.integrationMajorVersion,
      sourceKindId: registration.sourceKindId,
      scopes: [...registration.scopes].sort(),
      ...(registration.classification.size === 0
        ? {}
        : { classification: [...registration.classification].sort() }),
      ...(registration.aclMaximumAgeSeconds === undefined
        ? {}
        : { aclMaximumAgeSeconds: registration.aclMaximumAgeSeconds }),
      ...(registration.liveMaximumAgeSeconds === undefined
        ? {}
        : { liveMaximumAgeSeconds: registration.liveMaximumAgeSeconds }),
    }));
  }
}
