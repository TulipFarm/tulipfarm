import { useEffect, useState } from 'react';
import { AgentFanout } from '@tulipfarm/sprout/agent-fanout';
import { Button } from '@tulipfarm/sprout/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@tulipfarm/sprout/collapsible';
import { MessageResponse } from '@tulipfarm/sprout/message-response';
import type { LiveSubagents } from './conversation-stream';
import {
  delegationView,
  fanoutRoot,
  formatCredits,
  isActiveSubagent,
  subagentStatusLabel,
  type DelegationTool,
} from './subagent-fanout-state';

/**
 * The sub-agents of one `agents.delegate` call, live while they run. AgentFanout draws the agents; the list under it
 * holds what AgentFanout has no place for: each agent's credits, Stop, and final report.
 */
export function SubagentFanout({
  tool,
  live,
  stop,
}: {
  tool: DelegationTool;
  live?: LiveSubagents | undefined;
  /** Stops one running sub-agent. Absent once the reply no longer runs. */
  stop?: ((key: string) => Promise<unknown>) | undefined;
}) {
  const view = delegationView(tool, live);
  const ticking = !!view?.live && view.entries.some(isActiveSubagent);
  const [now, setNow] = useState(() => Date.now());
  const [stopping, setStopping] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    if (!ticking) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking]);
  if (!view) return null;
  return (
    <section aria-label="Sub-agents" className="space-y-2">
      <AgentFanout agent={fanoutRoot(view, now)} title="Sub-agents" layout="auto" />
      <ul className="space-y-1 text-sm">
        {view.entries.map(entry => (
          <li key={entry.key} className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{entry.name}</span>
              <span className="text-muted-foreground">
                {subagentStatusLabel[entry.status]} · {formatCredits(entry.credits)}
              </span>
              {stop && view.live && isActiveSubagent(entry) && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={stopping.has(entry.key)}
                  onClick={() => {
                    setStopping(current => new Set(current).add(entry.key));
                    void stop(entry.key).catch(() =>
                      setStopping(current => {
                        const next = new Set(current);
                        next.delete(entry.key);
                        return next;
                      }),
                    );
                  }}
                >
                  {stopping.has(entry.key) ? 'Stopping' : `Stop ${entry.name}`}
                </Button>
              )}
            </div>
            {entry.report && (
              <Collapsible>
                <CollapsibleTrigger render={<Button variant="ghost" size="sm" />}>Report</CollapsibleTrigger>
                <CollapsibleContent>
                  <MessageResponse>{entry.report}</MessageResponse>
                </CollapsibleContent>
              </Collapsible>
            )}
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted-foreground">Total: {formatCredits(view.totalCredits)}</p>
    </section>
  );
}
