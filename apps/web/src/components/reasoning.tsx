import type { ReactNode } from 'react';
import { ChevronDown } from 'reicon-react/icons/ChevronDown';
import { Sparkle } from 'reicon-react/icons/Sparkle';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@tulipfarm/sprout/collapsible';
import { ThinkingState } from './thinking-state';

export function Reasoning({
  state,
  children,
  defaultOpen = false,
}: {
  state: { kind: 'thinking' } | { kind: 'complete'; duration: string } | { kind: 'interrupted' };
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  const label =
    state.kind === 'thinking'
      ? 'Thinking'
      : state.kind === 'complete'
        ? `Thought for ${state.duration}`
        : 'Thinking interrupted';
  return (
    <Collapsible defaultOpen={defaultOpen}>
      <CollapsibleTrigger className="group flex min-h-8 max-w-full items-center gap-2 rounded-md text-left text-sm text-muted-foreground hover:text-foreground">
        <Sparkle size={16} aria-hidden="true" />
        {state.kind === 'thinking' ? <ThinkingState /> : <span>{label}</span>}
        <ChevronDown
          size={14}
          aria-hidden="true"
          className="shrink-0 transition-transform group-aria-expanded:rotate-180"
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="my-2 ml-2 border-l-2 pl-5 text-base text-muted-foreground">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}
