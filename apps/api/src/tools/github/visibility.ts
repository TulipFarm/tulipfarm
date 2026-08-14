import type { IntegrationStore } from "@tulipfarm/storage";
import { isGitHubInstalled } from "../../integrations/github-status";
import { GITHUB_TOOL_NAMES } from "./tools";

/** The GitHub Skill is hidden by the same live install-status gate as its Tool family. */
export const GITHUB_SKILL_NAME = "github";

/** GitHub Tools register at boot but are exposed per turn only when installed. */
export async function githubExcludedToolNames(status: {
  integrations: IntegrationStore;
  businessId: string;
}): Promise<ReadonlySet<string>> {
  return (await isGitHubInstalled(status)) ? new Set() : GITHUB_TOOL_NAMES;
}

/** Same live check, projected onto the disabled-bundled-skill overlay so the GitHub Skill
 * disappears alongside the tool family it documents. */
export async function githubDisabledSkillNames(status: {
  integrations: IntegrationStore;
  businessId: string;
}): Promise<ReadonlySet<string>> {
  return (await isGitHubInstalled(status)) ? new Set() : new Set([GITHUB_SKILL_NAME]);
}
