import { apiGet, apiSend } from "./api";

/*
 * Read-only client for the Soul Explorer API. The soul repo is a git directory on the API
 * server; these endpoints expose a recursive file tree and raw file contents for browsing.
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

export type SoulGitStatus = {
  remoteConfigured: boolean;
  ahead: number;
  behind: number;
  headSha: string | null;
  lastSyncError: string | null;
  lastSyncAt: string | null;
};

export type SoulGitConfig = {
  remoteUrl?: string;
  credentialSet: boolean;
  status: SoulGitStatus;
};

export function getGitConfig(): Promise<SoulGitConfig> {
  return apiGet<SoulGitConfig>("/api/v1/soul/git-config");
}

/** `credential` is write-only; pass it only when the user typed a new one. */
export function putGitConfig(remoteUrl: string, credential?: string): Promise<void> {
  return apiSend("PUT", "/api/v1/soul/git-config", { remoteUrl, credential });
}

export function syncSoul(): Promise<void> {
  return apiSend("POST", "/api/v1/soul/sync", {});
}

const GIT_AUTH_FAILURE_PATTERN =
  /could not read username|authentication failed|terminal prompts disabled|support for password authentication was removed|invalid username or password/i;

export function friendlyGitError(raw: string): string {
  if (GIT_AUTH_FAILURE_PATTERN.test(raw)) {
    return "Authentication failed — this remote needs a personal access token with repo access. Add one below.";
  }
  return raw;
}
