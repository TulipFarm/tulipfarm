import { Link } from "@remix-run/react";
import { useId, useMemo, useState } from "react";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Select } from "~/components/ui/select";
import {
  groupByCategory,
  matchesSkillQuery,
  SKILL_REACH_LABEL,
  SKILL_REACH_ORDER,
  type SkillReach,
  shouldGroupByCategory,
  skillCategory,
  skillFacts,
} from "~/lib/skill-facts";
import type { SkillSummary } from "~/lib/skills";
import { SkillRow } from "./skill-row";

function Stat({ value, label }: { value: number; label: string }) {
  return (
    <div>
      <p className="font-mono text-lg tabular-nums text-foreground">{value}</p>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  );
}

function SkillList({
  skills,
  headingLevel,
}: {
  skills: readonly SkillSummary[];
  headingLevel?: 2 | 3;
}) {
  return (
    <ul className="divide-y divide-border overflow-hidden rounded-md border border-border">
      {skills.map((skill) => (
        <li key={skill.name} className="min-w-0">
          <SkillRow skill={skill} headingLevel={headingLevel} />
        </li>
      ))}
    </ul>
  );
}

/**
 * The installed Skill catalog: every procedure this instance can load, grouped by the category its
 * author gave it.
 *
 * Filtering is client-side and deliberately so — the whole Soul's Skills arrive in one response, so
 * a round trip per keystroke would buy nothing. The reach filter exists because the question that
 * actually sends an operator to this page is rarely "what is installed" and usually "what did I
 * install that touches the network", which no name search can answer.
 */
export function SkillCatalog({ skills }: { skills: readonly SkillSummary[] }) {
  const searchId = useId();
  const categoryId = useId();
  const reachId = useId();
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [reach, setReach] = useState<SkillReach | "">("");

  const categories = useMemo(
    () => [...new Set(skills.map(skillCategory))].sort((left, right) => left.localeCompare(right)),
    [skills]
  );

  const visible = useMemo(
    () =>
      skills.filter(
        (skill) =>
          matchesSkillQuery(skill, query) &&
          (category === "" || skillCategory(skill) === category) &&
          (reach === "" || skillFacts(skill).reach === reach)
      ),
    [skills, query, category, reach]
  );

  const groups = useMemo(() => groupByCategory(visible), [visible]);
  const grouped = useMemo(() => shouldGroupByCategory(groups), [groups]);
  const reaching = useMemo(
    () => skills.filter((skill) => skillFacts(skill).reach !== "instructions-only").length,
    [skills]
  );
  const filtered = visible.length !== skills.length;

  if (skills.length === 0) {
    return (
      <div className="flex flex-col items-start gap-3 rounded-md border border-dashed border-border px-4 py-10">
        <p className="text-sm text-foreground">No skills installed yet.</p>
        <p className="max-w-prose text-sm text-muted-foreground">
          A skill teaches your agents one repeatable job. Browse the marketplace above to install
          one, or describe the job in chat and have an agent write it for you.
        </p>
        {/*
          Deliberately not a second "Browse marketplace": the page header already carries that
          link, and the same target twice is one target a screen reader cannot tell apart.
        */}
        <Button asChild size="sm" variant="outline">
          <Link to="/?agent=skill-forge">Ask an agent to write one</Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end gap-x-8 gap-y-4 border-b border-border pb-5">
        <Stat value={skills.length} label={skills.length === 1 ? "skill" : "skills"} />
        <Stat
          value={categories.length}
          label={categories.length === 1 ? "category" : "categories"}
        />
        <Stat value={reaching} label="reach beyond text" />
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="min-w-0 flex-1">
          <label htmlFor={searchId} className="mb-1 block text-xs text-muted-foreground">
            Search skills
          </label>
          <Input
            id={searchId}
            type="search"
            value={query}
            placeholder="Name, what it does, or a tool it calls"
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <div className="sm:w-44">
          <label htmlFor={categoryId} className="mb-1 block text-xs text-muted-foreground">
            Category
          </label>
          <Select
            id={categoryId}
            value={category}
            onChange={(event) => setCategory(event.target.value)}
          >
            <option value="">Any category</option>
            {categories.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </Select>
        </div>
        <div className="sm:w-44">
          <label htmlFor={reachId} className="mb-1 block text-xs text-muted-foreground">
            Reach
          </label>
          <Select
            id={reachId}
            value={reach}
            onChange={(event) => setReach(event.target.value as SkillReach | "")}
          >
            <option value="">Any reach</option>
            {SKILL_REACH_ORDER.map((value) => (
              <option key={value} value={value}>
                {SKILL_REACH_LABEL[value]}
              </option>
            ))}
          </Select>
        </div>
      </div>

      <p role="status" className="text-xs text-muted-foreground">
        {filtered ? `${visible.length} of ${skills.length} skills match` : ""}
      </p>

      {visible.length === 0 ? (
        <p className="rounded-md border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">
          No skill matches those filters. Clear the search or widen the category and reach.
        </p>
      ) : grouped ? (
        groups.map(([name, members], index) => (
          <section
            key={name}
            aria-labelledby={`${searchId}-category-${index}`}
            className="flex flex-col gap-3"
          >
            <div className="flex items-baseline gap-2">
              <h2
                id={`${searchId}-category-${index}`}
                className="text-[0.625rem] font-medium uppercase tracking-[0.2em] text-muted-foreground"
              >
                {name.replaceAll("-", " ")}
              </h2>
              <span className="font-mono text-[11px] tabular-nums text-muted-foreground/70">
                {members.length}
              </span>
              <span aria-hidden className="h-px flex-1 bg-border" />
            </div>
            <SkillList skills={members} />
          </section>
        ))
      ) : (
        <SkillList skills={visible} headingLevel={2} />
      )}
    </div>
  );
}
