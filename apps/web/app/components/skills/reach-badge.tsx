import { Badge } from "~/components/ui/badge";
import { SKILL_REACH_LABEL, type SkillReach } from "~/lib/skill-facts";

/**
 * What a Skill reaches, as its own chip.
 *
 * The scale is ordered — instructions, then code, then network, then your secrets — so the tone
 * ramps with it. `instructions-only` takes the success tone because a Skill that is nothing but
 * prose genuinely is the safe case, and `needs-secrets` takes danger because leasing a credential
 * to third-party code is the one an operator must not skim past. The word carries the fact on its
 * own, so the hue is never the only thing saying it.
 */
export function SkillReachBadge({ reach }: { reach: SkillReach }) {
  const variant =
    reach === "instructions-only"
      ? "success"
      : reach === "runs-code"
        ? "info"
        : reach === "reaches-network"
          ? "warning"
          : "danger";

  return <Badge variant={variant}>{SKILL_REACH_LABEL[reach]}</Badge>;
}
