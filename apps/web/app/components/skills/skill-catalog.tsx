import { useId, useMemo, useState } from "react";
import { Search } from "~/components/icons";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Link } from "~/components/ui/link";
import { type SortDir, SortHeader } from "~/components/ui/sort-header";
import { agentDisplayName } from "~/lib/agent-capabilities";
import type { AgentSummary } from "~/lib/agents";
import { timeAgo } from "~/lib/schema";
import { matchesSkillQuery, SKILL_REACH_LABEL, skillFacts } from "~/lib/skill-facts";
import type { SkillSummary } from "~/lib/skills";
import { skillAudience } from "./audience-panel";
import { SkillReachBadge } from "./reach-badge";

type SkillSortKey = "name" | "description" | "type" | "author" | "updated";
type SkillSort = { key: SkillSortKey; dir: SortDir };

function skillType(skill: SkillSummary): string {
  return skill.category?.replaceAll("-", " ") ?? "uncategorised";
}

function compareText(left: string | undefined, right: string | undefined, dir: SortDir): number {
  if (!left && !right) return 0;
  if (!left) return 1;
  if (!right) return -1;
  return left.localeCompare(right) * (dir === "asc" ? 1 : -1);
}

function compareSkills(left: SkillSummary, right: SkillSummary, sort: SkillSort): number {
  const compared =
    sort.key === "name"
      ? compareText(left.name, right.name, sort.dir)
      : sort.key === "description"
        ? compareText(left.description, right.description, sort.dir)
        : sort.key === "type"
          ? compareText(skillType(left), skillType(right), sort.dir)
          : sort.key === "author"
            ? compareText(left.author, right.author, sort.dir)
            : compareText(left.updatedAt, right.updatedAt, sort.dir);
  return compared || left.name.localeCompare(right.name);
}

function AgentsCell({ skill, agents }: { skill: SkillSummary; agents: readonly AgentSummary[] }) {
  const pinned = skillAudience(skill.name, agents).pinned;
  if (pinned.length === 0) return <span className="text-muted-foreground">{"\u2014"}</span>;

  const shown = pinned.slice(0, 2);
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <div className="min-w-0 truncate">
        {shown.map((agent, index) => (
          <span key={agent.name}>
            {index > 0 ? ", " : null}
            <Link
              to={`/agents/${encodeURIComponent(agent.name)}`}
              className="text-foreground underline-offset-4 hover:underline"
            >
              {agentDisplayName(agent)}
            </Link>
          </span>
        ))}
      </div>
      {pinned.length > shown.length ? (
        <span
          className="shrink-0 rounded-md border border-border px-1.5 py-0.5 text-xs text-muted-foreground"
          title={pinned.slice(shown.length).map(agentDisplayName).join(", ")}
        >
          +{pinned.length - shown.length}
        </span>
      ) : null}
    </div>
  );
}

export function SkillCatalog({
  skills,
  agents,
}: {
  skills: readonly SkillSummary[];
  agents: readonly AgentSummary[];
}) {
  const searchId = useId();
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SkillSort>({ key: "name", dir: "asc" });

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return skills
      .filter((skill) => {
        if (needle === "") return true;
        const agentNames = skillAudience(skill.name, agents).pinned.map(agentDisplayName);
        return (
          matchesSkillQuery(skill, needle) ||
          [skillType(skill), skill.author ?? "", ...agentNames]
            .join(" ")
            .toLowerCase()
            .includes(needle)
        );
      })
      .sort((left, right) => compareSkills(left, right, sort));
  }, [agents, query, skills, sort]);

  function onSort(key: SkillSortKey) {
    setSort((current) => ({
      key,
      dir: current.key === key && current.dir === "asc" ? "desc" : "asc",
    }));
  }

  const header = (key: SkillSortKey, label: string, className = "") => (
    <SortHeader
      label={label}
      sortKey={key}
      active={sort.key === key}
      dir={sort.key === key ? sort.dir : "asc"}
      onSort={onSort}
      className={`border-b border-border ${className}`}
    />
  );

  return (
    <section aria-labelledby="installed-skills-heading" className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <h2 id="installed-skills-heading" className="text-base font-medium text-foreground">
            Installed skills
          </h2>
          <span className="rounded-md border border-border px-1.5 py-0.5 text-xs tabular-nums text-muted-foreground">
            {skills.length}
          </span>
        </div>

        <div className="relative w-full sm:max-w-xs">
          <Search
            aria-hidden
            className="pointer-events-none absolute top-1/2 start-2.5 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <label htmlFor={searchId} className="sr-only">
            Search installed skills
          </label>
          <Input
            id={searchId}
            type="search"
            value={query}
            placeholder="Search skills, tools, or hosts"
            className="ps-8"
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
      </div>

      <p role="status" className={query.trim() ? "text-xs text-muted-foreground" : "sr-only"}>
        {query.trim() ? `${visible.length} of ${skills.length} skills match` : ""}
      </p>

      {skills.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-4 py-12 text-center text-sm text-muted-foreground">
          No skills installed yet.
        </p>
      ) : visible.length === 0 ? (
        <div className="flex flex-col items-center gap-3 py-12 text-sm text-muted-foreground">
          <p>No installed skill matches that search.</p>
          <Button variant="outline" onClick={() => setQuery("")}>
            Clear search
          </Button>
        </div>
      ) : (
        <div className="min-w-0 rounded-lg border border-border bg-card">
          <table className="w-full table-fixed border-separate border-spacing-0 text-sm">
            <caption className="sr-only">Installed skills and their declared reach</caption>
            <thead>
              <tr>
                {header("name", "Name")}
                {header("description", "Description", "hidden md:table-cell")}
                {header("type", "Type", "hidden lg:table-cell lg:w-28")}
                <SortHeader
                  label="Agents"
                  sortKey="agents"
                  className="hidden border-b border-border xl:table-cell"
                />
                {header("author", "Author", "hidden 2xl:table-cell")}
                {header("updated", "Updated", "hidden xl:table-cell xl:w-28")}
              </tr>
            </thead>
            <tbody className="[&>tr:last-child>td]:border-b-0 [&>tr>td]:border-b [&>tr>td]:border-border">
              {visible.map((skill) => (
                <tr key={skill.name} className="group transition-colors hover:bg-muted/50">
                  <td className="px-3 py-3 align-top">
                    <Link
                      to={`/skills/${encodeURIComponent(skill.name)}`}
                      className="break-words font-medium text-foreground underline-offset-4 hover:underline"
                    >
                      {skill.name}
                    </Link>
                    <p className="mt-1 break-words text-muted-foreground md:hidden">
                      {skill.description ?? "No description written."}
                    </p>
                    <Link
                      to={`/skills/${encodeURIComponent(skill.name)}#skill-reach`}
                      aria-label={`Declared reach for ${skill.name}: ${SKILL_REACH_LABEL[skillFacts(skill).reach]}`}
                      className="mt-1 flex min-h-11 w-fit items-center rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:min-h-6"
                    >
                      <SkillReachBadge reach={skillFacts(skill).reach} />
                    </Link>
                  </td>
                  <td className="hidden px-3 py-3 align-top text-muted-foreground md:table-cell">
                    <p className="break-words">{skill.description ?? "No description written."}</p>
                  </td>
                  <td className="hidden px-3 py-3 align-top lg:table-cell">
                    <Badge
                      variant="neutral"
                      className="max-w-full whitespace-normal break-words capitalize"
                    >
                      {skillType(skill)}
                    </Badge>
                  </td>
                  <td className="hidden px-3 py-3 align-top xl:table-cell">
                    <AgentsCell skill={skill} agents={agents} />
                  </td>
                  <td className="hidden break-words px-3 py-3 align-top text-muted-foreground 2xl:table-cell">
                    {skill.author ?? "\u2014"}
                  </td>
                  <td className="hidden px-3 py-3 align-top text-muted-foreground xl:table-cell">
                    {skill.updatedAt ? (
                      <span title={new Date(skill.updatedAt).toLocaleString()}>
                        {timeAgo(skill.updatedAt)}
                      </span>
                    ) : (
                      "\u2014"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
