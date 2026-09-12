import { useId, useMemo, useState } from "react";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Combobox } from "~/components/ui/combobox";
import { Input } from "~/components/ui/input";
import { Link } from "~/components/ui/link";
import type { MarketplaceCatalog, MarketplaceSkill } from "~/lib/skills";
import { skillRowKey } from "~/lib/skills";

const UNCATEGORISED = "uncategorised";
const ANY_CATEGORY = "Any category";

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
  const headingId = useId();
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [categoryInput, setCategoryInput] = useState(ANY_CATEGORY);
  const [updatesOnly, setUpdatesOnly] = useState(false);

  const categories = useMemo(
    () =>
      [...new Set(catalog.skills.map(categoryOf))].sort((left, right) => left.localeCompare(right)),
    [catalog.skills]
  );

  const visible = useMemo(
    () =>
      catalog.skills
        .filter(
          (skill) =>
            matches(skill, query) &&
            (category === "" || categoryOf(skill) === category) &&
            (!updatesOnly || skill.updateAvailable)
        )
        .sort((left, right) => left.name.localeCompare(right.name)),
    [catalog.skills, query, category, updatesOnly]
  );

  const updateCount = useMemo(
    () => catalog.skills.filter((skill) => skill.updateAvailable).length,
    [catalog.skills]
  );
  return (
    <section aria-labelledby={headingId} className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 id={headingId} className="text-base font-medium">
            Official catalog
          </h2>
          <p className="mt-1 break-words text-sm text-muted-foreground">
            From {catalog.source}. Review the audit before installing.
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={busy || visible.length === 0}
          onClick={() => onReview(catalog.scanId, visible)}
        >
          Review {visible.length === catalog.skills.length ? "all" : "these"} ({visible.length})
        </Button>
      </div>
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
            <Combobox
              id={categoryId}
              value={categoryInput}
              options={[ANY_CATEGORY, ...categories]}
              onValueChange={setCategoryInput}
              onCommit={(value) => {
                if (value === ANY_CATEGORY || categories.includes(value)) {
                  setCategory(value === ANY_CATEGORY ? "" : value);
                  setCategoryInput(value);
                } else {
                  setCategoryInput(category || ANY_CATEGORY);
                }
              }}
              emptyLabel="Choose a listed category."
            />
          </div>
          {updateCount > 0 ? (
            <Button
              size="sm"
              variant={updatesOnly ? "secondary" : "outline"}
              aria-pressed={updatesOnly}
              onClick={() => setUpdatesOnly((previous) => !previous)}
            >
              {updateCount} {updateCount === 1 ? "update" : "updates"}
            </Button>
          ) : null}
        </div>

        <p
          role="status"
          className={
            visible.length === catalog.skills.length ? "sr-only" : "text-xs text-muted-foreground"
          }
        >
          {visible.length === catalog.skills.length
            ? ""
            : `${visible.length} of ${catalog.skills.length} skills match`}
        </p>

        {visible.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-10 text-center text-sm text-muted-foreground">
            <p>Nothing in the catalog matches that. Try another search or clear the filters.</p>
            <Button
              variant="outline"
              onClick={() => {
                setQuery("");
                setCategory("");
                setCategoryInput(ANY_CATEGORY);
                setUpdatesOnly(false);
              }}
            >
              Clear filters
            </Button>
          </div>
        ) : (
          <ul className="min-w-0 divide-y divide-border border-y border-border">
            {visible.map((skill) => (
              <li
                key={skillRowKey(skill)}
                className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-2 py-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto] lg:items-center lg:gap-x-6"
              >
                <div className="min-w-0">
                  {skill.installed ? (
                    <Link
                      to={`/skills/${encodeURIComponent(skill.name)}`}
                      className="break-words text-sm font-medium text-foreground underline-offset-4 hover:underline"
                    >
                      {skill.name}
                    </Link>
                  ) : (
                    <p className="break-words text-sm font-medium text-foreground">{skill.name}</p>
                  )}
                  <p className="mt-1 text-xs capitalize text-muted-foreground">
                    {categoryOf(skill).replaceAll("-", " ")}
                  </p>
                  {skill.installs !== undefined ? (
                    <p className="text-xs text-muted-foreground">{skill.installs} installs</p>
                  ) : null}
                </div>
                <p className="col-span-2 row-start-2 min-w-0 break-words text-sm text-muted-foreground lg:col-span-1 lg:col-start-2 lg:row-start-1">
                  {skill.description ?? "No description written."}
                </p>
                <div className="col-start-2 row-start-1 flex flex-col items-end gap-2 lg:col-start-3">
                  <InstallState skill={skill} />
                  {skill.installed && !skill.updateAvailable ? (
                    <span className="text-xs text-muted-foreground">Up to date</span>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      className="w-24 shrink-0"
                      disabled={busy}
                      aria-label={`${skill.updateAvailable ? "Update" : "Install"} ${skill.name}`}
                      onClick={() => onReview(catalog.scanId, [skill])}
                    >
                      {skill.updateAvailable ? "Update" : "Install"}
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
