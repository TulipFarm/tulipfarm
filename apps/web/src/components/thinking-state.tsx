import { useEffect, useState } from 'react';
import { ThinkingOrb, type OrbState } from 'thinking-orbs';
import { Spinner } from '@tulipfarm/sprout/spinner';
import './thinking-state.css';

export type ThinkingActivity = OrbState;

function elapsed(since: number, now: number) {
  const seconds = Math.max(0, Math.floor((now - since) / 1000));
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <span aria-hidden="true" className="text-sm tabular-nums text-muted-foreground">
      {elapsed(since, now)}
    </span>
  );
}

export function ThinkingState({
  label = 'Thinking',
  variant = 'shimmer',
  activity = 'working',
  since,
}: {
  label?: string;
  variant?: 'shimmer' | 'dots' | 'spinner' | 'orb';
  activity?: ThinkingActivity;
  since?: string | number | undefined;
}) {
  const started = since === undefined ? undefined : typeof since === 'number' ? since : Date.parse(since);
  return (
    <span
      data-slot="thinking-state"
      role="status"
      className="inline-flex min-h-8 items-center gap-2 text-sm font-medium text-muted-foreground"
    >
      {variant === 'spinner' && <Spinner aria-hidden="true" />}
      {variant === 'orb' && (
        <span aria-hidden="true" className="grid size-5 shrink-0 place-items-center">
          <ThinkingOrb state={activity} size={20} theme="auto" aria-label="" />
        </span>
      )}
      <span className={variant === 'shimmer' || variant === 'orb' ? 'thinking-shimmer' : undefined}>{label}</span>
      {variant === 'dots' && (
        <span aria-hidden="true" className="thinking-dots inline-flex gap-1">
          <span />
          <span />
          <span />
        </span>
      )}
      {variant === 'orb' && started !== undefined && Number.isFinite(started) && <Elapsed since={started} />}
    </span>
  );
}
