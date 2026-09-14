import { useId, useMemo, useState } from "react";
import { Input } from "~/components/ui/input";
import { Select } from "~/components/ui/select";
import {
  builtInAgentDisplayName,
  capabilityFacts,
  matchesQuery,
  REACH_LABEL,
  type Reach,
  UNGROUPED_DOMAIN,
} from "~/lib/agent-capabilities";
import type { AgentSummary, Autonomy, BuiltInAgentSummary } from "~/lib/agents";
import { AgentRow } from "./agent-row";

const AUTONOMY_OPTIONS: readonly Autonomy[] = ["manual", "approval-required", "supervised", "full"];
const REACH_OPTIONS: readonly Reach[] = ["read-only", "changes-data", "unrestricted"];

/** One roster row's worth of data, custom or built-in, carried through filtering and grouping. */
type RosterEntry =
  | { key: string; kind: "custom"; agent: AgentSummary; routineUsageCount: number }
  | { key: string; kind: "built-in"; agent: BuiltInAgentSummary };

function matchesBuiltInQuery(agent: BuiltInAgentSummary, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === "") return true;
  return (
    builtInAgentDisplayName(agent.id).toLowerCase().includes(needle) ||
    agent.purpose.toLowerCase().includes(needle)
  );
}

/** Built-in agents have no domain to group by, so they collect in `UNGROUPED_DOMAIN` alongside
 * any custom agent that never declared one — the same "Other" bucket, not a section of their own. */
function domainOf(entry: RosterEntry): string {
  return entry.kind === "custom" ? (entry.agent.domain ?? UNGROUPED_DOMAIN) : UNGROUPED_DOMAIN;
}

function groupByDomain(entries: readonly RosterEntry[]): [string, RosterEntry[]][] {
  const groups = new Map<string, RosterEntry[]>();
  for (const entry of entries) {
    const key = domainOf(entry);
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }

  return [...groups.entries()].sort(([a], [b]) => {
    if (a === UNGROUPED_DOMAIN) return 1;
    if (b === UNGROUPED_DOMAIN) return -1;
    return a.localeCompare(b);
  });
}

/** Headings earn their place only once some domain actually collects more than one entry. */
function shouldGroupByDomain(groups: readonly [string, unknown[]][]): boolean {
  return groups.some(([, members]) => members.length > 1);
}

function AgentList({
  entries,
  headingLevel,
}: {
  entries: readonly RosterEntry[];
  headingLevel?: 2 | 3;
}) {
  return (
    <ul className="divide-y divide-border overflow-hidden rounded-md border border-border">
      {entries.map((entry) => (
        <li key={entry.key} className="min-w-0">
          {entry.kind === "custom" ? (
            <AgentRow
              kind="custom"
              agent={entry.agent}
              headingLevel={headingLevel}
              routineUsageCount={entry.routineUsageCount}
            />
          ) : (
            <AgentRow kind="built-in" agent={entry.agent} headingLevel={headingLevel} />
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * The agent roster: every agent this instance holds, custom and built-in together in one list,
 * grouped by the domain it works in.
 *
 * Filtering is client-side and deliberately so — the whole Soul's agents arrive in one response, so
 * a round trip per keystroke would buy nothing. Grouping stays on while filtering, because the
 * domain heading is the answer to "what kinds of agent exist here" and dropping it under a query
 * would flatten exactly the structure the page exists to show.
 */
export function AgentRoster({
  agents,
  builtIn = [],
  usageByAgent = {},
}: {
  agents: readonly AgentSummary[];
  /** The runtime's own agents — no persona, no Soul entry. Always shown, filters or not. */
  builtIn?: readonly BuiltInAgentSummary[];
  /** Agent name → published Routines whose `agent` State points at it. See `routineUsageByAgent`. */
  usageByAgent?: Readonly<Record<string, number>>;
}) {
  const searchId = useId();
  const autonomyId = useId();
  const reachId = useId();
  const [query, setQuery] = useState("");
  const [autonomy, setAutonomy] = useState<Autonomy | "">("");
  const [reach, setReach] = useState<Reach | "">("");

  const total = agents.length + builtIn.length;

  const visible = useMemo<RosterEntry[]>(() => {
    const customVisible = agents
      .filter(
        (agent) =>
          matchesQuery(agent, query) &&
          (autonomy === "" || agent.autonomy === autonomy) &&
          (reach === "" || capabilityFacts(agent.capabilityRestrictions).reach === reach)
      )
      .map(
        (agent): RosterEntry => ({
          key: `custom:${agent.name}`,
          kind: "custom",
          agent,
          routineUsageCount: usageByAgent[agent.name] ?? 0,
        })
      );

    /*
     * A built-in agent has no authority or reach — it's a fixed platform prompt — so an
     * authority/reach filter can never match one honestly and it drops out rather than pretending
     * "any authority" was a match.
     */
    const builtInVisible: RosterEntry[] =
      autonomy !== "" || reach !== ""
        ? []
        : builtIn
            .filter((agent) => matchesBuiltInQuery(agent, query))
            .map((agent) => ({ key: `built-in:${agent.id}`, kind: "built-in" as const, agent }));

    return [...customVisible, ...builtInVisible];
  }, [agents, builtIn, query, autonomy, reach, usageByAgent]);

  const groups = useMemo(() => groupByDomain(visible), [visible]);
  const grouped = useMemo(() => shouldGroupByDomain(groups), [groups]);
  const filtered = visible.length !== total;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="min-w-0 flex-1">
          <label htmlFor={searchId} className="mb-1 block text-xs text-muted-foreground">
            Search agents
          </label>
          <Input
            id={searchId}
            type="search"
            value={query}
            placeholder="Name, what it does, or a record type"
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <div className="sm:w-44">
          <label htmlFor={autonomyId} className="mb-1 block text-xs text-muted-foreground">
            Authority
          </label>
          <Select
            id={autonomyId}
            value={autonomy}
            onChange={(event) => setAutonomy(event.target.value as Autonomy | "")}
          >
            <option value="">Any authority</option>
            {AUTONOMY_OPTIONS.map((value) => (
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
            onChange={(event) => setReach(event.target.value as Reach | "")}
          >
            <option value="">Any reach</option>
            {REACH_OPTIONS.map((value) => (
              <option key={value} value={value}>
                {REACH_LABEL[value]}
              </option>
            ))}
          </Select>
        </div>
      </div>

      <p role="status" className="text-xs text-muted-foreground">
        {filtered ? `${visible.length} of ${total} agents match` : ""}
      </p>

      {visible.length === 0 ? (
        <p className="rounded-md border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">
          No agent matches those filters. Clear the search or widen the authority and reach.
        </p>
      ) : grouped ? (
        <>
          {groups.map(([domain, members], index) => (
            <section
              key={domain}
              aria-labelledby={`${searchId}-domain-${index}`}
              className="flex flex-col gap-3"
            >
              <div className="flex items-baseline gap-2">
                <h2
                  id={`${searchId}-domain-${index}`}
                  className="text-xs font-medium text-muted-foreground"
                >
                  {domain}
                </h2>
                <span className="font-mono text-[11px] tabular-nums text-muted-foreground/70">
                  {members.length}
                </span>
                <span aria-hidden className="h-px flex-1 bg-border" />
              </div>
              <AgentList entries={members} />
            </section>
          ))}
        </>
      ) : (
        <AgentList entries={visible} headingLevel={2} />
      )}
    </div>
  );
}
