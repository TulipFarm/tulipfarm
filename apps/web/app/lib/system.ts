import { apiDelete, apiGet, apiWrite } from "./api";

export type UpdateCheck = {
  version: string;
  latest?: string | null;
  updateAvailable: boolean;
  checkedAt?: string | null;
};

export async function getUpdateCheck(): Promise<UpdateCheck> {
  return apiGet<UpdateCheck>("/api/v1/system/update-check");
}

export type PublicOrigins = {
  webOrigin: string;
  apiOrigin: string;
  callbackUrl: string;
  source: "database" | "environment" | "default";
  locked: boolean;
};

export function getPublicOrigins(): Promise<PublicOrigins> {
  return apiGet<PublicOrigins>("/api/v1/system/public-origins");
}

export function savePublicOrigins(input: {
  webOrigin: string;
  apiOrigin?: string | null;
}): Promise<PublicOrigins> {
  return apiWrite<PublicOrigins>("PUT", "/api/v1/system/public-origins", input);
}

export async function resetPublicOrigins(): Promise<PublicOrigins> {
  await apiDelete("/api/v1/system/public-origins");
  return getPublicOrigins();
}
