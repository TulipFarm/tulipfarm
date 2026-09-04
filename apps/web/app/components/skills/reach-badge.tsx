import { Badge } from "~/components/ui/badge";
import { SKILL_REACH_LABEL, type SkillReach } from "~/lib/skill-facts";

/**
 * What a Skill reaches, as its own chip.
 *
 * The scale is ordered — instructions, then code, then network, then your secrets — so the tone
 * ramps with it, and `needs-secrets` takes danger because leasing a credential to third-party code
 * is the one an operator must not skim past.
 *
 * `instructions-only` is deliberately the *neutral* end, not a green one. It is the safe case, but
 * it is also the overwhelmingly common one, so colouring it painted a whole catalog in badges
 * announcing that nothing was wrong — the eye went to every row that had earned no attention. A
 * hue here has to mark the exception, not the rule. Nothing is lost by demoting it, because the
 * word carries the fact on its own; the hue is never the only thing saying it.
 */
export function SkillReachBadge({ reach }: { reach: SkillReach }) {
  const variant =
    reach === "instructions-only"
      ? "neutral"
      : reach === "runs-code"
        ? "info"
        : reach === "reaches-network"
          ? "warning"
          : "danger";

  return <Badge variant={variant}>{SKILL_REACH_LABEL[reach]}</Badge>;
}
