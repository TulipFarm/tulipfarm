import { apiGet, apiSend, apiWrite } from "./api";
import type { TelemetryLevel } from "./telemetry";

export type SetupStatus = {
  needsSetup: boolean;
  telemetry: { maxLevel: TelemetryLevel; enabled: boolean };
};

export async function getSetupStatus(): Promise<SetupStatus> {
  return apiGet<SetupStatus>("/api/v1/setup/status");
}

export async function setupAdmin(name: string, email: string, password: string): Promise<void> {
  // 201 with user body — use apiWrite; we don't need the response body
  await apiWrite("POST", "/api/v1/setup/admin", { name, email, password });
}

export async function setupBusiness(
  name: string,
  description: string,
  website: string
): Promise<void> {
  await apiSend("POST", "/api/v1/setup/business", { name, description, website });
}

export async function setupGit(remoteUrl: string, credentials?: string): Promise<void> {
  await apiSend("POST", "/api/v1/setup/git", { remoteUrl, credentials });
}

export async function completeSetup(telemetryLevel: TelemetryLevel = 2): Promise<void> {
  await apiSend("POST", "/api/v1/setup/complete", { telemetryLevel });
}
