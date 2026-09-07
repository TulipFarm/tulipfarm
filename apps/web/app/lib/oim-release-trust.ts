import { apiDelete, apiGet, apiWrite } from "./api";

const OIM_BASE = "/api/v1/integrations/oim";
const TRUST_BASE = `${OIM_BASE}/release-trust`;

export type OimTrustRootPurpose = "release" | "revocation";

export type OimTrustRoot = {
  purpose: OimTrustRootPurpose;
  keyId: string;
  publicKeyPem: string;
  createdAt: string;
  createdBy: string;
  disabledAt?: string;
  disabledBy?: string;
};

export type OimRevocationFeed = {
  url: string;
  updatedAt: string;
  updatedBy: string;
  disabledAt?: string;
  disabledBy?: string;
};

export type OimAutoPatchPreference = {
  integrationId: string;
  majorVersion: number;
  version: string;
  support: "official" | "community";
  autoPatchOptIn: boolean;
};

export async function listOimTrustRoots(includeDisabled = false): Promise<OimTrustRoot[]> {
  const query = includeDisabled ? "?includeDisabled=true" : "";
  const result = await apiGet<{ roots: OimTrustRoot[] }>(`${TRUST_BASE}/roots${query}`);
  return result.roots;
}

export async function addOimTrustRoot(input: {
  purpose: OimTrustRootPurpose;
  keyId: string;
  publicKeyPem: string;
}): Promise<OimTrustRoot> {
  const result = await apiWrite<{ root: OimTrustRoot }>("POST", `${TRUST_BASE}/roots`, input);
  return result.root;
}

export async function disableOimTrustRoot(
  purpose: OimTrustRootPurpose,
  keyId: string
): Promise<OimTrustRoot> {
  const result = await apiWrite<{ root: OimTrustRoot }>(
    "DELETE",
    `${TRUST_BASE}/roots/${purpose}/${encodeURIComponent(keyId)}`,
    {}
  );
  return result.root;
}

export async function getOimRevocationFeed(): Promise<OimRevocationFeed | null> {
  const result = await apiGet<{ feed: OimRevocationFeed | null }>(`${TRUST_BASE}/feed`);
  return result.feed;
}

export async function setOimRevocationFeed(url: string): Promise<OimRevocationFeed> {
  const result = await apiWrite<{ feed: OimRevocationFeed }>("PUT", `${TRUST_BASE}/feed`, { url });
  return result.feed;
}

export async function disableOimRevocationFeed(): Promise<void> {
  await apiDelete(`${TRUST_BASE}/feed`);
}

export async function importOimRevocations(
  envelope: unknown
): Promise<{ sequence: number; expiresAt: string }> {
  return apiWrite("POST", `${TRUST_BASE}/revocations`, envelope);
}

function autoPatchPath(integrationId: string, majorVersion: number): string {
  return `${OIM_BASE}/${encodeURIComponent(integrationId)}/majors/${majorVersion}/auto-patch`;
}

function normalizeAutoPatchPreference(value: {
  integration_id: string;
  major_version: number;
  version: string;
  support: "official" | "community";
  auto_patch_opt_in: boolean;
}): OimAutoPatchPreference {
  return {
    integrationId: value.integration_id,
    majorVersion: value.major_version,
    version: value.version,
    support: value.support,
    autoPatchOptIn: value.auto_patch_opt_in,
  };
}

export async function getOimAutoPatchPreference(
  integrationId: string,
  majorVersion: number
): Promise<OimAutoPatchPreference> {
  const value = await apiGet<{
    integration_id: string;
    major_version: number;
    version: string;
    support: "official" | "community";
    auto_patch_opt_in: boolean;
  }>(autoPatchPath(integrationId, majorVersion));
  return normalizeAutoPatchPreference(value);
}

export async function setOimAutoPatchPreference(
  integrationId: string,
  majorVersion: number,
  autoPatchOptIn: boolean
): Promise<OimAutoPatchPreference> {
  const value = await apiWrite<{
    integration_id: string;
    major_version: number;
    version: string;
    support: "official" | "community";
    auto_patch_opt_in: boolean;
  }>("PATCH", autoPatchPath(integrationId, majorVersion), {
    auto_patch_opt_in: autoPatchOptIn,
  });
  return normalizeAutoPatchPreference(value);
}
