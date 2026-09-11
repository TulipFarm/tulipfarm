import type { TeamBusinessAssetOwnership } from "@tulipfarm/schema";
import { DEFAULT_ASSISTANT_ID, type SoulAgent } from "@tulipfarm/soul";
import type { AssetPrincipal, TeamAssetService } from "../team-assets/service";

export async function mayUseAgent(
  agent: SoulAgent,
  principal: AssetPrincipal,
  teamAssets: Pick<TeamAssetService, "access"> | undefined
): Promise<boolean> {
  if (agent.id === DEFAULT_ASSISTANT_ID) return true;
  if (!teamAssets) return false;
  const ownership = agent.frontmatter.ownership;
  const access = await teamAssets.access(
    "agent",
    agent.name,
    principal,
    typeof ownership === "object" && ownership !== null
      ? (ownership as TeamBusinessAssetOwnership)
      : undefined
  );
  return access.levels.includes("use");
}
