import { apiGet, apiWrite } from "./api";

export type NativeProvider = "slack" | "github";
export type NativeChannelRoute = {
  id: string;
  integrationId: string;
  agentId: string;
  channelId: string | null;
  threadId: string | null;
  eventTypes: string[];
  priority: number;
  status: "active" | "revoked";
  principalIds: string[];
};
export type NativeRoutineEvent =
  | "github.push"
  | "github.issues"
  | "github.pull_request"
  | "slack.reaction_added"
  | "slack.reaction_removed";
export type NativeRoutineRouteInput = {
  integrationId: string;
  destination: string;
  eventType: NativeRoutineEvent;
  routineId: string;
  enabled: boolean;
};
export type NativeRoutineRoute = Omit<NativeRoutineRouteInput, "eventType"> & {
  id: string;
  eventType: string;
};
export type NativeChannelSetup = {
  provider: NativeProvider;
  webhookUrl: string;
  integrations: { id: string; externalTenantId: string; status: "active" | "revoked" }[];
  routes: NativeChannelRoute[];
  routineRoutes: NativeRoutineRoute[];
};
export type NativeChannelSetupInput = {
  integrationId: string;
  routeId: string;
  agentId: string;
  channelId: string;
  threadId?: string;
  principalIds: string[];
  enabled: boolean;
};

const setupPath = (provider: NativeProvider) => `/api/v1/integrations/native/${provider}/setup`;

export function getNativeChannelSetup(provider: NativeProvider): Promise<NativeChannelSetup> {
  return apiGet(setupPath(provider));
}

export function saveNativeChannelSetup(
  provider: NativeProvider,
  input: NativeChannelSetupInput
): Promise<NativeChannelSetup> {
  return apiWrite("PUT", setupPath(provider), input);
}

export function saveNativeRoutineRoute(
  provider: NativeProvider,
  input: NativeRoutineRouteInput
): Promise<NativeChannelSetup> {
  return apiWrite("PUT", `/api/v1/integrations/native/${provider}/routines`, input);
}
