import { describe, expect, it } from "vitest";
import { parseProductTelemetryEvent, sanitizeTelemetryUrl } from "./product-telemetry";

const bootstrap = () => ({
  schema_version: 1,
  event_id: "a54bf560-d378-4343-848c-4f94667f1c57",
  installation_id: "c328dc11-a3a8-426c-9254-f6106457cdf8",
  event_type: "instance_bootstrapped",
  occurred_at: "2026-09-14T12:00:00.000Z",
  telemetry_level: 0,
  data: {
    version: "0.18.30",
    os: "linux",
    architecture: "arm64",
    deployment_method: "container",
    first_boot_at: "2026-09-14T11:59:00.000Z",
    business_name: "Muskan Vijayvargiya Studio",
    soul_repository_url: "https://github.com/example/soul.git",
  },
});
const snapshot = (level = 1) => ({
  ...bootstrap(),
  event_type: "instance_snapshot",
  telemetry_level: level,
  data: {
    users: 3,
    resource_types: 2,
    integrations: 1,
    skills: 4,
    bundled_skills: 8,
    agents: 2,
    routines: 1,
  },
});

describe("product telemetry wire contract", () => {
  it("accepts identified bootstrap and counts-only snapshots", () => {
    expect(parseProductTelemetryEvent(bootstrap())).toEqual(bootstrap());
    expect(parseProductTelemetryEvent(snapshot())).toEqual(snapshot());
  });
  it("accepts named inventory only at level two", () => {
    const report = {
      ...snapshot(2),
      data: { ...snapshot().data, resource_type_names: ["Customer"], inventory_truncated: true },
    };
    expect(parseProductTelemetryEvent(report)).toEqual(report);
    expect(() => parseProductTelemetryEvent({ ...report, telemetry_level: 1 })).toThrow();
  });
  it.each([
    { ...bootstrap(), secret: "token" },
    { ...bootstrap(), data: { ...bootstrap().data, description: "private" } },
    { ...bootstrap(), telemetry_level: 1 },
    { ...snapshot(), telemetry_level: 0 },
    { ...bootstrap(), event_id: "not-an-id" },
    { ...bootstrap(), occurred_at: "2026-02-30T00:00:00.000Z" },
    { ...snapshot(), data: { ...snapshot().data, users: -1 } },
    { ...snapshot(), data: { ...snapshot().data, users: 1.5 } },
    { ...snapshot(), data: { ...snapshot().data, users: Number.NaN } },
    { ...snapshot(), data: { ...snapshot().data, users: Number.MAX_SAFE_INTEGER + 1 } },
    {
      ...bootstrap(),
      data: {
        ...bootstrap().data,
        soul_repository_url: "https://token@github.com/example/soul.git",
      },
    },
    { ...bootstrap(), data: { ...bootstrap().data, instance_url: "https://example.com/path" } },
    {
      ...bootstrap(),
      data: { ...bootstrap().data, business_website: "https://example.com/?token=secret" },
    },
    { ...snapshot(2), data: { ...snapshot().data, agent_names: Array(201).fill("agent") } },
    { ...snapshot(2), data: { ...snapshot().data, agent_names: ["a".repeat(129)] } },
  ])("rejects malformed or disallowed report %#", (report) => {
    expect(() => parseProductTelemetryEvent(report)).toThrow("Invalid product telemetry report");
  });
  it("caps total size as well as individual fields", () => {
    const names = Array.from({ length: 200 }, (_, index) => `${index}${"a".repeat(120)}`);
    expect(() =>
      parseProductTelemetryEvent({
        ...snapshot(2),
        data: { ...snapshot().data, agent_names: names },
      })
    ).toThrow();
  });
  it("rejects multibyte and UTF-16 oversized reports", () => {
    const names = Array.from({ length: 100 }, (_, index) => `${index}${"界".repeat(120)}`);
    expect(() =>
      parseProductTelemetryEvent({
        ...snapshot(2),
        data: { ...snapshot().data, agent_names: names },
      })
    ).toThrow();
  });
  it("does not include submitted contents in errors", () => {
    expect(() => parseProductTelemetryEvent({ secret: "do-not-print" })).toThrow(
      /^Invalid product telemetry report$/
    );
  });
});

describe("telemetry URL sanitization", () => {
  it("strips credentials, query, fragment and optionally paths", () => {
    const url = "https://alice:secret@example.com/business/soul.git?token=private#section";
    expect(sanitizeTelemetryUrl(url)).toBe("https://example.com/business/soul.git");
    expect(sanitizeTelemetryUrl(url, true)).toBe("https://example.com");
  });
  it.each([
    undefined,
    "",
    "git@example.com:soul",
    "ssh://example.com/soul",
    "file:///etc/passwd",
    "invalid",
    "https://example.com/\nsecret",
    "https://example.com/\\private",
    "https://example.com/%0asecret",
  ])("omits invalid URL %s", (url) => {
    expect(sanitizeTelemetryUrl(url)).toBeUndefined();
  });
});
