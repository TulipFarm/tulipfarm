import { apiGet } from "./api";

export type UpdateCheck = {
  version: string;
  latest?: string | null;
  updateAvailable: boolean;
  checkedAt?: string | null;
};

export async function getUpdateCheck(): Promise<UpdateCheck> {
  return apiGet<UpdateCheck>("/api/v1/system/update-check");
}
