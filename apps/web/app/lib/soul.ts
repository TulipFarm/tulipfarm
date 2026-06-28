import { apiGet } from "./api";

/*
 * Read-only client for the Soul Explorer API. The soul repo is a git directory on the API
 * server; these endpoints expose a recursive file tree and raw file contents for browsing.
 * Mirrors lib/api.ts conventions (cookie-first auth, ApiError on non-2xx).
 */

export type SoulTreeNode = {
  name: string;
  path: string;
  type: "file" | "dir";
  size?: number;
  children?: SoulTreeNode[];
};

export type SoulFile = {
  path: string;
  content: string;
  size: number;
  language: string;
  binary?: boolean;
  tooLarge?: boolean;
};

export async function getSoulTree(): Promise<SoulTreeNode[]> {
  const body = await apiGet<{ root: SoulTreeNode[] }>("/api/v1/soul/tree");
  return body.root;
}

export function getSoulFile(path: string): Promise<SoulFile> {
  return apiGet<SoulFile>(`/api/v1/soul/file?path=${encodeURIComponent(path)}`);
}
