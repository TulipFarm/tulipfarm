import { useEffect, useState } from 'react';
import { bud, type AvatarState } from '@tulipfarm/conversations/avatar';
import { TulipAvatar } from '@/components/tulip-avatar';
export { budState } from './bud-state';

export function BudWelcome() {
  const [ready, setReady] = useState(false);
  const [waving, setWaving] = useState(true);
  useEffect(() => {
    if (!ready) return;
    const timer = setTimeout(() => setWaving(false), 3000);
    return () => clearTimeout(timer);
  }, [ready]);
  const state = waving ? 'Waving' : 'Idle';
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
        onReady={() => setReady(true)}
      />
    </span>
  );
}

export function Bud({ state }: { state: AvatarState }) {
  return (
    <div className="flex shrink-0 items-center" data-bud-state={state}>
      <TulipAvatar
        name={bud.name}
        character={bud.character}
        color={bud.color}
        view={bud.view}
        state={state}
        size={40}
        variant="plain"
      />
    </div>
  );
}
