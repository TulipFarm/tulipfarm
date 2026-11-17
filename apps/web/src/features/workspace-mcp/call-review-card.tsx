import { useEffect, useId, useRef, useState } from 'react';
import { Plug } from 'reicon-react/icons/Plug';
import { Button } from '@tulipfarm/sprout/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@tulipfarm/sprout/collapsible';
import { Skeleton } from '@tulipfarm/sprout/skeleton';
import { useMcpAction, useMcpApi } from './queries';
import { McpCommandFeedback, useMcpCommand } from './state';
import { toolTitle } from './tools-tab';

/** A connected-app call waiting in a chat for the asker's approval. Shows nothing once it is decided. */
export function McpCallReviewCard({
  workspaceId,
  actionId,
  onSettled,
}: {
  workspaceId: string;
  actionId: string;
  onSettled?: () => Promise<void> | void;
}) {
  const id = useId();
  const api = useMcpApi(workspaceId);
  const read = useMcpAction(api, actionId);
  const command = useMcpCommand();
  const [now, setNow] = useState(Date.now);
  const decision = useRef<'approve' | 'reject'>('approve');
  const latest = useRef(onSettled);
  latest.current = onSettled;
  const action = read.state.kind === 'ready' ? read.state.data : null;
  const waiting = action?.status === 'awaiting-approval';
  useEffect(() => {
    if (action && !waiting) void latest.current?.();
  }, [action?.status]);
  const expires = action ? Date.parse(action.expiresAt) : Infinity;
  useEffect(() => {
    if (!Number.isFinite(expires)) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.min(Math.max(expires - Date.now(), 0) + 20, 2147483647));
    return () => clearTimeout(timer);
  }, [expires]);
  if (read.state.kind === 'loading')
    return (
      <div role="status" aria-label="Loading request" className="space-y-2">
        <Skeleton />
        <span className="sr-only">Loading request…</span>
      </div>
    );
  if (!action || !waiting) return null;
  if (!action.canDecide || action.visibility !== 'full')
    return (
      <p role="status" className="text-xs text-muted-foreground">
        Waiting for approval from the person who asked.
      </p>
    );
  if (now >= expires)
    return (
      <p role="status" className="text-xs text-muted-foreground">
        Expired without a decision. Nothing ran. Ask again to retry.
      </p>
    );
  const tool = toolTitle({ name: action.exact.toolName, title: null });
  const sending = command.busy ? decision.current : null;
  const decide = (choice: 'approve' | 'reject') => {
    decision.current = choice;
    void command.run(
      () => api.decide(action.id, { requestId: crypto.randomUUID(), digest: action.digest, decision: choice }),
      read.refresh,
    );
  };
  return (
    <section
      aria-labelledby={`${id}-title`}
      className="space-y-3 rounded-xl border border-border bg-card px-3 py-3 text-card-foreground"
    >
      <h4 id={`${id}-title`} className="flex items-center gap-2 text-sm font-medium">
        <Plug size={16} aria-hidden="true" />
        <span className="min-w-0 break-words">
          {action.integrationName} · {tool}
        </span>
      </h4>
      <Collapsible>
        <CollapsibleTrigger render={<Button variant="ghost" size="sm" />}>Details</CollapsibleTrigger>
        <CollapsibleContent>
          <pre
            aria-label={`What ${action.integrationName} will receive`}
            className="mt-2 max-h-48 overflow-auto rounded-md bg-muted p-2 font-mono text-xs whitespace-pre-wrap wrap-anywhere"
          >
            {JSON.stringify(action.exact.arguments, null, 2)}
          </pre>
        </CollapsibleContent>
      </Collapsible>
      <McpCommandFeedback
        command={command}
        check={async () => {
          await read.refresh();
          command.reset();
        }}
      />
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
        <p className="text-xs text-muted-foreground">Nothing runs until you choose.</p>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="ghost"
            size="sm"
            disabled={command.blocked}
            aria-busy={sending === 'reject'}
            onClick={() => decide('reject')}
          >
            Don’t run
          </Button>
          <Button
            size="sm"
            disabled={command.blocked}
            aria-busy={sending === 'approve'}
            onClick={() => decide('approve')}
          >
            {sending === 'approve' ? 'Running…' : 'Run'}
          </Button>
        </div>
      </div>
    </section>
  );
}
