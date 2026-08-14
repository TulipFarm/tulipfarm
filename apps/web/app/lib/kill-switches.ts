import { apiDelete, apiGet, apiWrite } from "./api";

export type KillSwitch = {
  id: string;
  scopeKind: string;
  scopeValue?: string;
  reasonCode: string;
  enabledAt: string;
  enabledBy: string;
  enabled: boolean;
  disabledAt?: string;
  disabledBy?: string;
};

export type KillSwitchModel = {
  killSwitches: KillSwitch[];
  /**
   * The scopes a guard can actually evaluate. The picker is built from this rather than from a
   * local list so the UI can never offer a scope that would arm a switch enforcing nothing.
   */
  enforceableScopeKinds: string[];
};

export function getKillSwitches(): Promise<KillSwitchModel> {
  return apiGet<KillSwitchModel>("/api/v1/kill-switches");
}

export function armKillSwitch(input: {
  scopeKind: string;
  scopeValue?: string;
  reasonCode: string;
}): Promise<{ killSwitch: KillSwitch }> {
  return apiWrite<{ killSwitch: KillSwitch }>("POST", "/api/v1/kill-switches", input);
}

export function standDownKillSwitch(id: string): Promise<void> {
  return apiDelete(`/api/v1/kill-switches/${encodeURIComponent(id)}`);
}

const SCOPE_LABELS: Readonly<Record<string, string>> = {
  all_mutations: "Every mutating effect",
  tool: "One Tool",
  provider: "One provider",
  integration: "One Integration",
  destination: "One destination",
  data_class: "One data class",
};

export function scopeKindLabel(kind: string): string {
  return SCOPE_LABELS[kind] ?? kind;
}

/** What the switch stops, in one line, for an operator deciding whether to stand it down. */
export function describeScope(item: Pick<KillSwitch, "scopeKind" | "scopeValue">): string {
  if (item.scopeKind === "all_mutations") return "Every mutating effect";
  return `${scopeKindLabel(item.scopeKind)}: ${item.scopeValue ?? "—"}`;
}
