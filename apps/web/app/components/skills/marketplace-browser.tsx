import { useId, useMemo, useState } from "react";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Panel } from "~/components/ui/panel";
import { Select } from "~/components/ui/select";
import type { MarketplaceCatalog, MarketplaceSkill } from "~/lib/skills";
import { skillRowKey } from "~/lib/skills";

const UNCATEGORISED = "uncategorised";

function categoryOf(skill: MarketplaceSkill): string {
  return skill.category ?? UNCATEGORISED;
}

function matches(skill: MarketplaceSkill, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === "") return true;
  return `${skill.name} ${skill.description ?? ""} ${skill.category ?? ""}`
    .toLowerCase()
    .includes(needle);
}

function InstallState({ skill }: { skill: MarketplaceSkill }) {
  if (skill.updateAvailable) return <Badge variant="primary">Update available</Badge>;
  if (skill.installed) return <Badge variant="success">Installed</Badge>;
  return null;
}

/**
 * The official catalog, as something you can actually search.
 *
 * The catalog runs to dozens of packages, so browsing it by scrolling a list of category headings
 * only answers "what exists" and never "is there one for X" — which is the question that brings
 * anyone here. Search and the category filter are therefore the primary controls, and the list is
 * whatever survives them.
 *
 * Filtering is client-side because the whole catalog arrives in one response; a request per
 * keystroke would buy nothing and would make the page fail differently when the catalog repo is
 * unreachable.
 */
export function MarketplaceBrowser({
  catalog,
  busy,
  onReview,
}: {
  catalog: MarketplaceCatalog;
  busy: boolean;
  /** Hands the selection to the unchanged scan → audit → confirm pipeline. */
  onReview: (scanId: string, skills: MarketplaceSkill[]) => void;
}) {
  const searchId = useId();
  const categoryId = useId();
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [updatesOnly, setUpdatesOnly] = useState(false);

  const categories = useMemo(
    () =>
      [...new Set(catalog.skills.map(categoryOf))].sort((left, right) => left.localeCompare(right)),
    [catalog.skills]
  );

  const visible = useMemo(
    () =>
      catalog.skills.filter(
        (skill) =>
          matches(skill, query) &&
          (category === "" || categoryOf(skill) === category) &&
          (!updatesOnly || skill.updateAvailable)
      ),
    [catalog.skills, query, category, updatesOnly]
  );

  // Grouped, not flat: the category headings are what make an unfiltered catalog skimmable, and
  // they mirror how installed skills are grouped on /skills so the two lists read the same way.
  const grouped = useMemo(() => {
    const groups = new Map<string, MarketplaceSkill[]>();
    for (const skill of visible) {
      const key = categoryOf(skill);
      const existing = groups.get(key);
      if (existing) existing.push(skill);
      else groups.set(key, [skill]);
    }
    return [...groups].sort(([left], [right]) => {
      if (left === UNCATEGORISED) return 1;
      if (right === UNCATEGORISED) return -1;
      return left.localeCompare(right);
    });
  }, [visible]);

  const updateCount = useMemo(
    () => catalog.skills.filter((skill) => skill.updateAvailable).length,
    [catalog.skills]
  );
  const installedCount = useMemo(
    () => catalog.skills.filter((skill) => skill.installed).length,
    [catalog.skills]
  );

  return (
    <Panel
      title="Official catalog"
      description={`${catalog.skills.length} skills reviewed and published by TulipFarm, from ${catalog.source}. ${installedCount} already installed.`}
      actions={
        <Button
          size="sm"
          variant="outline"
          disabled={busy || visible.length === 0}
          onClick={() => onReview(catalog.scanId, visible)}
        >
          Review {visible.length === catalog.skills.length ? "all" : "these"} ({visible.length})
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="min-w-0 flex-1">
            <label htmlFor={searchId} className="mb-1 block text-xs text-muted-foreground">
              Search the catalog
            </label>
            <Input
              id={searchId}
              type="search"
              value={query}
              placeholder="What do you want an agent to be able to do?"
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
                  {value.replaceAll("-", " ")}
                </option>
              ))}
            </Select>
          </div>
          {updateCount > 0 ? (
            <Button
              size="sm"
              variant={updatesOnly ? "default" : "outline"}
              aria-pressed={updatesOnly}
              onClick={() => setUpdatesOnly((previous) => !previous)}
            >
              {updateCount} {updateCount === 1 ? "update" : "updates"}
            </Button>
          ) : null}
        </div>

        <p role="status" className="text-xs text-muted-foreground">
          {visible.length === catalog.skills.length
            ? ""
            : `${visible.length} of ${catalog.skills.length} skills match`}
        </p>

        {visible.length === 0 ? (
          <p className="rounded-md border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">
            Nothing in the catalog matches that. Try a broader word, or install from a git repo
            below.
          </p>
        ) : (
          <div className="flex flex-col gap-5">
            {grouped.map(([groupName, skills]) => (
              <section key={groupName} className="flex flex-col gap-1.5">
                <h3 className="text-xs font-medium capitalize text-muted-foreground">
                  {groupName.replaceAll("-", " ")}
                </h3>
                <ul className="divide-y divide-border overflow-hidden rounded-md border border-border">
                  {skills.map((skill) => (
                    <li
                      key={skillRowKey(skill)}
                      className="flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-center sm:gap-4"
                    >
                      <div className="min-w-0 sm:w-52 sm:shrink-0 lg:w-60">
                        <p className="truncate text-sm font-medium leading-tight text-foreground">
                          {skill.name}
                        </p>
                        {skill.installs !== undefined ? (
                          <p className="truncate text-[11px] leading-tight text-muted-foreground">
                            {skill.installs} installs
                          </p>
                        ) : null}
                      </div>
                      <p className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
                        {skill.description ?? "No description written."}
                      </p>
                      <div className="sm:w-24 sm:shrink-0">
                        <InstallState skill={skill} />
                      </div>
                      {skill.installed && !skill.updateAvailable ? (
                        <span className="text-xs text-muted-foreground sm:w-24 sm:shrink-0 sm:text-right">
                          Up to date
                        </span>
                      ) : (
                        <Button
                          size="sm"
                          variant={skill.updateAvailable ? "default" : "outline"}
                          className="shrink-0 sm:w-24"
                          disabled={busy}
                          // #447: every row ships the same verb, so the accessible name is all a
                          // reader navigating by role has to tell them apart. The visible word
                          // stays first so it remains contained in the name (WCAG 2.5.3).
                          aria-label={`${skill.updateAvailable ? "Update" : "Install"} ${skill.name}`}
                          onClick={() => onReview(catalog.scanId, [skill])}
                        >
                          {skill.updateAvailable ? "Update" : "Install"}
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}
      </div>
    </Panel>
  );
}
