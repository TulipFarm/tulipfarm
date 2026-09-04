import { useId, useMemo, useState } from "react";
import { Search } from "~/components/icons";
import { Badge } from "~/components/ui/badge";
import { Input } from "~/components/ui/input";
import { Link } from "~/components/ui/link";
import { type SortDir, SortHeader } from "~/components/ui/sort-header";
import { agentDisplayName } from "~/lib/agent-capabilities";
import type { AgentSummary } from "~/lib/agents";
import { timeAgo } from "~/lib/schema";
import type { SkillSummary } from "~/lib/skills";
import { skillAudience } from "./audience-panel";

type SkillSortKey = "name" | "description" | "type" | "author" | "updated";
type SkillSort = { key: SkillSortKey; dir: SortDir };

function skillType(skill: SkillSummary): string {
  return skill.category?.replaceAll("-", " ") ?? "uncategorised";
}

function skillTypeBadge(skill: SkillSummary): "info" | "warning" | "neutral" {
  if (skill.category === "core") return "info";
  if (skill.category === "forge") return "warning";
  return "neutral";
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
        return [
          skill.name,
          skill.description ?? "",
          skillType(skill),
          skill.author ?? "",
          ...agentNames,
        ]
          .join(" ")
          .toLowerCase()
          .includes(needle);
      })
      .sort((left, right) => compareSkills(left, right, sort));
  }, [agents, query, skills, sort]);

  function onSort(key: SkillSortKey) {
    setSort((current) => ({
      key,
      dir: current.key === key && current.dir === "asc" ? "desc" : "asc",
    }));
  }

  const header = (key: SkillSortKey, label: string) => (
    <SortHeader
      label={label}
      sortKey={key}
      active={sort.key === key}
      dir={sort.key === key ? sort.dir : "asc"}
      onSort={onSort}
      className="border-b border-border"
    />
  );

  return (
    <section aria-labelledby="installed-skills-heading" className="flex flex-col gap-4">
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
            placeholder="Search by name, type, agent, or author"
            className="ps-8"
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
      </div>

      {skills.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-4 py-12 text-center text-sm text-muted-foreground">
          No skills installed yet.
        </p>
      ) : visible.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-4 py-12 text-center text-sm text-muted-foreground">
          No installed skill matches that search.
        </p>
      ) : (
        <div className="max-h-[70svh] overflow-auto rounded-lg border border-border bg-card">
          <table className="w-full min-w-[64rem] border-separate border-spacing-0 text-sm">
            <thead className="sticky top-0 z-10">
              <tr>
                {header("name", "Name")}
                {header("description", "Description")}
                {header("type", "Type")}
                <SortHeader label="Agents" sortKey="agents" className="border-b border-border" />
                {header("author", "Author")}
                {header("updated", "Updated")}
              </tr>
            </thead>
            <tbody className="[&>tr:last-child>td]:border-b-0 [&>tr>td]:border-b [&>tr>td]:border-border">
              {visible.map((skill) => (
                <tr key={skill.name} className="group transition-colors hover:bg-muted/50">
                  <td className="w-48 px-3 py-2.5 align-top">
                    <Link
                      to={`/skills/${encodeURIComponent(skill.name)}`}
                      className="font-medium text-foreground underline-offset-4 group-hover:underline"
                    >
                      {skill.name}
                    </Link>
                  </td>
                  <td className="max-w-80 px-3 py-2.5 align-top text-muted-foreground">
                    <p className="truncate">{skill.description ?? "No description written."}</p>
                  </td>
                  <td className="w-36 px-3 py-2.5 align-top">
                    <Badge variant={skillTypeBadge(skill)} className="capitalize">
                      {skillType(skill)}
                    </Badge>
                  </td>
                  <td className="w-56 px-3 py-2.5 align-top">
                    <AgentsCell skill={skill} agents={agents} />
                  </td>
                  <td className="w-40 px-3 py-2.5 align-top text-muted-foreground">
                    {skill.author ?? "\u2014"}
                  </td>
                  <td className="w-28 whitespace-nowrap px-3 py-2.5 align-top text-muted-foreground">
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
