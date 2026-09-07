import { apiGet, apiWrite } from "./api";

export type AdhocConnectionRule = {
  location: "header" | "query";
  name: string;
  valuePrefix: string;
};

export type AdhocConnectionMatch =
  | { origin: string; state: "none" }
  | {
      origin: string;
      state: "match";
      connectionId: string;
      label: string;
      ownerScope: "personal" | "organization" | "team";
    }
  | {
      origin: string;
      state: "ambiguous";
      count: number;
      candidates: AdhocConnectionCandidate[];
    };

export type AdhocConnectionCandidate = {
  connectionId: string;
  label: string;
  ownerScope: "personal" | "organization" | "team";
};

export function safeChatReturn(candidate: string | null, requestUrl: URL): string | undefined {
  if (!candidate) return undefined;
  try {
    const resolved = new URL(candidate, requestUrl.origin);
    if (resolved.origin !== requestUrl.origin) return undefined;
    if (resolved.pathname !== "/" && !resolved.pathname.startsWith("/chat/")) return undefined;
    if (candidate.startsWith("//") || candidate.includes("\\")) return undefined;
    return `${resolved.pathname}${resolved.search}${resolved.hash}`;
  } catch {
    return undefined;
  }
}

export async function getAdhocConnection(origin: string): Promise<AdhocConnectionMatch> {
  return apiGet(`/api/v1/connections/adhoc?origin=${encodeURIComponent(origin)}`);
}

export async function createAdhocConnection(input: {
  origin: string;
  rule: AdhocConnectionRule;
  secretValue: string;
  label: string;
  scope: "personal" | "organization";
}): Promise<{ connectionId: string; origin: string; scope: string }> {
  return apiWrite("POST", "/api/v1/connections/adhoc", input);
}
