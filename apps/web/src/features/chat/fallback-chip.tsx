import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { ArrowUpRight } from 'reicon-react/icons/ArrowUpRight';
import { Danger } from 'reicon-react/icons/Danger';
import { InfoCircle } from 'reicon-react/icons/InfoCircle';
import { Key } from 'reicon-react/icons/Key';
import { Badge } from '@tulipfarm/sprout/badge';
import { Button } from '@tulipfarm/sprout/button';
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from '@tulipfarm/sprout/popover';
import type { ConversationMessage } from './conversation-api';
import {
  fallbackSummary,
  planLabels,
  planSwitchSummary,
  planUsageUrls,
  type FallbackSummary,
} from './reply-failure-copy';

const badgeVariants = { warning: 'warning', info: 'info', action: 'default' } as const;

function ReasonIcon({ summary }: { summary: FallbackSummary }) {
  if (summary.reason === 'sign-in') return <Key size={12} aria-hidden="true" />;
  if (summary.tone === 'warning') return <Danger size={12} aria-hidden="true" />;
  return <InfoCircle size={12} aria-hidden="true" />;
}

/** A compact note above the first reply another model wrote, with why and how to switch back in its details. */
export function FallbackChip({
  turn,
  answeredAt,
  modelName,
  slug,
  currentModel,
  canSwitchTo,
  switchModel,
}: {
  turn: NonNullable<ConversationMessage['turn']>;
  answeredAt: string;
  modelName: (id: string) => string;
  slug: string;
  /** The model the composer would send with now. */
  currentModel: string | undefined;
  canSwitchTo: (id: string) => boolean;
  switchModel: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const summary = fallbackSummary(turn.status, turn.errorCode, turn.stats?.model, modelName);
  if (!summary) return <PlanSwitchChip turn={turn} answeredAt={answeredAt} slug={slug} />;
  const { chosen, plan } = summary;
  const time = new Date(answeredAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const switchBack = chosen && chosen !== currentModel && canSwitchTo(chosen) ? chosen : null;
  const reconnect = summary.reason === 'sign-in' && summary.own && plan;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        nativeButton={false}
        aria-label={`Using ${summary.answered}. ${summary.short}. Show details`}
        render={<Badge variant={badgeVariants[summary.tone]} size="chip" />}
      >
        <ReasonIcon summary={summary} />
        <span className="text-foreground">
          Using <span className="font-semibold">{summary.answered}</span>
          <span className="text-muted-foreground"> · {summary.short}</span>
        </span>
      </PopoverTrigger>
      <PopoverContent align="start" side="bottom">
        <div className="space-y-3">
          <PopoverHeader>
            <PopoverTitle>{summary.short}</PopoverTitle>
            <PopoverDescription>{summary.detail}</PopoverDescription>
          </PopoverHeader>
          <p className="text-xs text-muted-foreground">{chosen ? `You chose ${summary.replaced} · ${time}` : time}</p>
          <div className="flex flex-wrap gap-2">
            {reconnect && (
              <Button
                size="sm"
                nativeButton={false}
                render={<Link to="/$workspaceSlug/settings/models" params={{ workspaceSlug: slug }} />}
              >
                Reconnect {planLabels[plan]}
              </Button>
            )}
            {switchBack && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  switchModel(switchBack);
                  setOpen(false);
                }}
              >
                Switch back to {summary.replaced}
              </Button>
            )}
            {plan && (
              <Button
                size="sm"
                variant="ghost"
                nativeButton={false}
                render={<a href={planUsageUrls[plan]} target="_blank" rel="noopener noreferrer" />}
              >
                Manage usage
                <ArrowUpRight size={14} aria-hidden="true" />
              </Button>
            )}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** A compact note above the first reply another of the member's plan accounts answered after the picked one couldn't. */
function PlanSwitchChip({
  turn,
  answeredAt,
  slug,
}: {
  turn: NonNullable<ConversationMessage['turn']>;
  answeredAt: string;
  slug: string;
}) {
  const summary = planSwitchSummary(turn);
  if (!summary) return null;
  const time = new Date(answeredAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return (
    <Popover>
      <PopoverTrigger
        nativeButton={false}
        aria-label={`Using ${summary.to}. ${summary.short}. Show details`}
        render={<Badge variant="info" size="chip" />}
      >
        <InfoCircle size={12} aria-hidden="true" />
        <span className="text-foreground">
          Using <span className="font-semibold">{summary.to}</span>
          <span className="text-muted-foreground"> · {summary.short}</span>
        </span>
      </PopoverTrigger>
      <PopoverContent align="start" side="bottom">
        <div className="space-y-3">
          <PopoverHeader>
            <PopoverTitle>{summary.short}</PopoverTitle>
            <PopoverDescription>{summary.detail}</PopoverDescription>
          </PopoverHeader>
          <p className="text-xs text-muted-foreground">{time}</p>
          {summary.own && (
            <Button
              size="sm"
              variant="outline"
              nativeButton={false}
              render={<Link to="/$workspaceSlug/settings/models" params={{ workspaceSlug: slug }} />}
            >
              Manage accounts
            </Button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
