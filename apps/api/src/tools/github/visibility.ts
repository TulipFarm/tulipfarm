import type { IntegrationStore } from "@tulipfarm/storage";
import { isGitHubInstalled } from "../../integrations/github-status";
import { GITHUB_TOOL_NAMES } from "./tools";

/** The bundled GitHub Skill's frontmatter `name` — the same install-status gate that hides the
 * tool family also disables this Skill (`apps/api/src/soul/skills/bundled.ts`'s disabled-name
 * overlay), so the model is never told to use tools it cannot see. */
export const GITHUB_SKILL_NAME = "github";

/**
 * The GitHub chat tool family is registered unconditionally at boot (its own effect dispatch
 * fails closed with no installation), so what's conditional is a turn's *visibility* into it —
 * computed live, per turn, so a business connecting GitHub mid-process-lifetime needs no restart.
 * See `docs/plans/2026-08-07-github-chat-tool-access.md`.
 */
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
