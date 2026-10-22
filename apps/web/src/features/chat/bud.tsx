import { useEffect, useState } from 'react';
import { bud, type AvatarState } from '@tulipfarm/conversations/avatar';
import { TulipAvatar } from '@/components/tulip-avatar';
import { useFlag } from '@/lib/feature-flags';
export { budState } from './bud-state';

// With the bud-avatar flag off, Bud keeps its place as a still, idle pose.
export function BudWelcome() {
  const animated = useFlag('bud-avatar');
  const [ready, setReady] = useState(false);
  const [waving, setWaving] = useState(true);
  useEffect(() => {
    if (!ready) return;
    const timer = setTimeout(() => setWaving(false), 3000);
    return () => clearTimeout(timer);
  }, [ready]);
  const state = animated && waving ? 'Waving' : 'Idle';
  return (
    <span className="shrink-0" data-bud-state={state}>
      <TulipAvatar
        name={bud.name}
        character={bud.character}
        color={bud.color}
        view={bud.view}
        state={state}
        size={64}
        variant="plain"
        paused={!animated}
        onReady={() => setReady(true)}
      />
    </span>
  );
}

export function Bud({ state }: { state: AvatarState }) {
  const animated = useFlag('bud-avatar');
  const shown = animated ? state : 'Idle';
  return (
    <div className="flex shrink-0 items-center" data-bud-state={shown}>
      <TulipAvatar
        name={bud.name}
        character={bud.character}
        color={bud.color}
        view={bud.view}
        state={shown}
        size={40}
        variant="plain"
        paused={!animated}
      />
    </div>
  );
}
