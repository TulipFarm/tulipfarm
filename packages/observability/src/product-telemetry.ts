export type ProductTelemetryLevel = 0 | 1 | 2;

export const PRODUCT_TELEMETRY_MAX_BYTES = 24_576;
export const PRODUCT_TELEMETRY_QUEUE = "product-telemetry";
export const PRODUCT_TELEMETRY_ENDPOINT = "https://telemetry.tulipfarm.site/v1/events";
export const PRODUCT_TELEMETRY_INTERVAL_MS = 86_400_000;

export interface ProductTelemetryBootstrapData {
  version: string;
  os: string;
  architecture: string;
  deployment_method: string;
  first_boot_at: string;
  business_name?: string;
  business_website?: string;
  instance_url?: string;
  soul_repository_url?: string;
}

export interface ProductTelemetrySnapshotData {
  users: number;
  resource_types: number;
  integrations: number;
  skills: number;
  bundled_skills: number;
  agents: number;
  routines: number;
  resource_type_names?: string[];
  integration_providers?: string[];
  skill_names?: string[];
  agent_names?: string[];
  inventory_truncated?: boolean;
}

interface ProductTelemetryEnvelope {
  schema_version: 1;
  event_id: string;
  installation_id: string;
  occurred_at: string;
}

export type ProductTelemetryEvent = ProductTelemetryEnvelope &
  (
    | {
        event_type: "instance_bootstrapped";
        telemetry_level: 0;
        data: ProductTelemetryBootstrapData;
      }
    | {
        event_type: "instance_snapshot";
        telemetry_level: 1 | 2;
        data: ProductTelemetrySnapshotData;
      }
  );

const ENVELOPE_KEYS = [
  "schema_version",
  "event_id",
  "installation_id",
  "event_type",
  "occurred_at",
  "telemetry_level",
  "data",
];
const BOOTSTRAP_REQUIRED = ["version", "os", "architecture", "deployment_method", "first_boot_at"];
const URL_FIELDS = ["business_website", "instance_url", "soul_repository_url"];
const COUNT_FIELDS = [
  "users",
  "resource_types",
  "integrations",
  "skills",
  "bundled_skills",
  "agents",
  "routines",
];
const NAME_FIELDS = ["resource_type_names", "integration_providers", "skill_names", "agent_names"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function invalid(): never {
  throw new Error("Invalid product telemetry report");
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, allowed: string[], required: string[]): void {
  if (
    Object.keys(value).some((key) => !allowed.includes(key)) ||
    required.some((key) => !Object.hasOwn(value, key))
  )
    invalid();
}

function text(value: unknown, limit: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= limit &&
    Array.from(value).every(
      (character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127
    )
  );
}

function iso(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

/** Returns only HTTP(S) locations, without authentication or request-specific data. */
export function sanitizeTelemetryUrl(value: unknown, originOnly = false): string | undefined {
  if (!text(value, 2048) || /\\|%(?:0[0-9a-f]|1[0-9a-f]|7f)/i.test(value)) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return originOnly ? url.origin : url.toString();
  } catch {
    return undefined;
  }
}

/** Validates an untrusted wire report; errors never contain submitted data. */
export function parseProductTelemetryEvent(value: unknown): ProductTelemetryEvent {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return invalid();
  }
  if (
    !serialized ||
    serialized.length * 2 > PRODUCT_TELEMETRY_MAX_BYTES ||
    new TextEncoder().encode(serialized).byteLength > PRODUCT_TELEMETRY_MAX_BYTES
  )
    invalid();
  const report = object(value);
  keys(report, ENVELOPE_KEYS, ENVELOPE_KEYS);
  if (
    report.schema_version !== 1 ||
    typeof report.event_id !== "string" ||
    !UUID.test(report.event_id) ||
    typeof report.installation_id !== "string" ||
    !UUID.test(report.installation_id) ||
    !iso(report.occurred_at)
  )
    invalid();
  const data = object(report.data);
  if (report.event_type === "instance_bootstrapped" && report.telemetry_level === 0) {
    keys(data, [...BOOTSTRAP_REQUIRED, "business_name", ...URL_FIELDS], BOOTSTRAP_REQUIRED);
    for (const field of BOOTSTRAP_REQUIRED) if (!text(data[field], 512)) invalid();
    if (!iso(data.first_boot_at)) invalid();
    if (Object.hasOwn(data, "business_name") && !text(data.business_name, 512)) invalid();
    for (const field of URL_FIELDS) {
      if (
        Object.hasOwn(data, field) &&
        (!text(data[field], 2048) ||
          sanitizeTelemetryUrl(data[field], field === "instance_url") !== data[field])
      )
        invalid();
    }
  } else if (
    report.event_type === "instance_snapshot" &&
    (report.telemetry_level === 1 || report.telemetry_level === 2)
  ) {
    keys(
      data,
      report.telemetry_level === 2
        ? [...COUNT_FIELDS, ...NAME_FIELDS, "inventory_truncated"]
        : COUNT_FIELDS,
      COUNT_FIELDS
    );
    for (const field of COUNT_FIELDS)
      if (typeof data[field] !== "number" || !Number.isSafeInteger(data[field]) || data[field] < 0)
        invalid();
    for (const field of NAME_FIELDS) {
      if (!Object.hasOwn(data, field)) continue;
      const names = data[field];
      if (!Array.isArray(names) || names.length > 200 || names.some((name) => !text(name, 128)))
        invalid();
    }
    if (Object.hasOwn(data, "inventory_truncated") && typeof data.inventory_truncated !== "boolean")
      invalid();
  } else {
    invalid();
  }
  return value as ProductTelemetryEvent;
}
