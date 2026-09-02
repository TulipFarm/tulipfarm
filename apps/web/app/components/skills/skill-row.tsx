import { Badge } from "~/components/ui/badge";
import { Link } from "~/components/ui/link";
import { skillFacts } from "~/lib/skill-facts";
import type { SkillSummary } from "~/lib/skills";
import { SkillReachBadge } from "./reach-badge";

/**
 * One Skill in the catalog, as a row.
 *
 * Matches the agent roster deliberately: a catalog grows to hundreds, and reach, provenance and the
 * tool count landing at the same x on every row is what lets a reader compare them by scanning.
 * Those columns are fixed-width, sized for their longest value, so a wide one can never shunt the
 * column out of line; the description is the single flexible column because it is the part a
 * scanning reader needs least and the detail page carries in full.
 *
 * The whole row is a link here, unlike an agent row: a Skill is never addressed, so there is no
 * second "use it now" action to compete with opening it.
 */
export function SkillRow({
  skill,
  headingLevel = 3,
}: {
  skill: SkillSummary;
  /** 2 in an ungrouped list, 3 under a category's `h2`, so the outline never skips a level. */
  headingLevel?: 2 | 3;
}) {
  const facts = skillFacts(skill);
  const Heading = `h${headingLevel}` as const;

  return (
    <Link
      to={`/skills/${encodeURIComponent(skill.name)}`}
      className="flex flex-col gap-2 px-3 py-2.5 outline-none transition-colors hover:bg-muted/40 focus-visible:bg-muted/50 focus-visible:ring-[3px] focus-visible:ring-inset focus-visible:ring-ring/50 sm:flex-row sm:items-center sm:gap-4"
    >
      <div className="min-w-0 sm:w-52 sm:shrink-0 lg:w-60">
        <Heading className="truncate text-sm font-medium leading-tight text-foreground">
          {skill.name}
        </Heading>
        <p className="truncate font-mono text-[11px] leading-tight text-muted-foreground">
          {skill.provenance}
          {skill.version ? ` · v${skill.version}` : ""}
        </p>
      </div>

      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-muted-foreground">
          {skill.description ?? "No description written."}
        </p>
        <p className="truncate font-mono text-[11px] leading-tight text-muted-foreground">
          {facts.tools.length > 0
            ? `${facts.tools.length} ${facts.tools.length === 1 ? "tool" : "tools"} · ${facts.tools.slice(0, 3).join(", ")}${facts.tools.length > 3 ? "…" : ""}`
            : "No tools declared"}
        </p>
      </div>

      <div className="sm:w-36 sm:shrink-0">
        <SkillReachBadge reach={facts.reach} />
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-1.5 sm:w-28">
        {facts.domains.length > 0 ? (
          <Badge variant="warning">
            {facts.domains.length} host{facts.domains.length === 1 ? "" : "s"}
          </Badge>
        ) : null}
        {facts.secrets.length > 0 ? (
          <Badge variant="danger">
            {facts.secrets.length} secret{facts.secrets.length === 1 ? "" : "s"}
          </Badge>
        ) : null}
      </div>
    </Link>
  );
}
