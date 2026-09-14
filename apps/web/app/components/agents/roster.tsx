import { useId, useMemo, useState } from "react";
import { Input } from "~/components/ui/input";
import { Select } from "~/components/ui/select";
import {
  capabilityFacts,
  groupByDomain,
  matchesQuery,
  REACH_LABEL,
  type Reach,
  shouldGroupByDomain,
} from "~/lib/agent-capabilities";
import type { AgentSummary, Autonomy, BuiltInAgentSummary } from "~/lib/agents";
import { AgentRow } from "./agent-row";
import { BuiltInAgentRow } from "./built-in-agent-row";

const AUTONOMY_OPTIONS: readonly Autonomy[] = ["manual", "approval-required", "supervised", "full"];
const REACH_OPTIONS: readonly Reach[] = ["read-only", "changes-data", "unrestricted"];

function AgentList({
  agents,
  headingLevel,
  usageByAgent,
}: {
  agents: readonly AgentSummary[];
  headingLevel?: 2 | 3;
  usageByAgent: Readonly<Record<string, number>>;
}) {
  return (
    <ul className="divide-y divide-border overflow-hidden rounded-md border border-border">
      {agents.map((agent) => (
        <li key={agent.name} className="min-w-0">
          <AgentRow
            agent={agent}
            headingLevel={headingLevel}
            routineUsageCount={usageByAgent[agent.name] ?? 0}
          />
        </li>
      ))}
    </ul>
  );
}

function BuiltInAgentList({
  agents,
  headingLevel,
}: {
  agents: readonly BuiltInAgentSummary[];
  headingLevel?: 2 | 3;
}) {
  return (
    <ul className="divide-y divide-border overflow-hidden rounded-md border border-border">
      {agents.map((agent) => (
        <li key={agent.id} className="min-w-0">
          <BuiltInAgentRow agent={agent} headingLevel={headingLevel} />
        </li>
      ))}
    </ul>
  );
}

/**
 * The agent roster: every agent this instance holds, grouped by the domain it works in.
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

  const visible = useMemo(
    () =>
      agents.filter(
        (agent) =>
          matchesQuery(agent, query) &&
          (autonomy === "" || agent.autonomy === autonomy) &&
          (reach === "" || capabilityFacts(agent.capabilityRestrictions).reach === reach)
      ),
    [agents, query, autonomy, reach]
  );

  const groups = useMemo(() => groupByDomain(visible), [visible]);
  const grouped = useMemo(() => shouldGroupByDomain(groups), [groups]);
  const filtered = visible.length !== agents.length;

  /*
   * A built-in agent has no authority or reach — it's a fixed platform prompt — so an
   * authority/reach filter can never match one honestly and the section hides rather than
   * pretending "any authority" was a match.
   */
  const visibleBuiltIn = useMemo(() => {
    if (autonomy !== "" || reach !== "") return [];
    const needle = query.trim().toLowerCase();
    if (needle === "") return builtIn;
    return builtIn.filter(
      (agent) =>
        agent.id.toLowerCase().includes(needle) || agent.purpose.toLowerCase().includes(needle)
    );
  }, [builtIn, query, autonomy, reach]);

  const nothingVisible = visible.length === 0 && visibleBuiltIn.length === 0;

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
        {filtered ? `${visible.length} of ${agents.length} agents match` : ""}
      </p>

      {nothingVisible ? (
        <p className="rounded-md border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">
          No agent matches those filters. Clear the search or widen the authority and reach.
        </p>
      ) : (
        <>
          {visible.length === 0 ? null : grouped ? (
            groups.map(([domain, members], index) => (
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
                <AgentList agents={members} usageByAgent={usageByAgent} />
              </section>
            ))
          ) : (
            <AgentList agents={visible} headingLevel={2} usageByAgent={usageByAgent} />
          )}

          {visibleBuiltIn.length > 0 ? (
            <section aria-labelledby={`${searchId}-built-in`} className="flex flex-col gap-3">
              <div className="flex items-baseline gap-2">
                <h2
                  id={`${searchId}-built-in`}
                  className="text-xs font-medium text-muted-foreground"
                >
                  Built-in
                </h2>
                <span className="font-mono text-[11px] tabular-nums text-muted-foreground/70">
                  {visibleBuiltIn.length}
                </span>
                <span aria-hidden className="h-px flex-1 bg-border" />
              </div>
              <BuiltInAgentList agents={visibleBuiltIn} />
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}
