import { useEffect, useMemo, useState } from 'react';
import { TypedText } from '@tulipfarm/sprout/typed-text';
import { useFirstSession } from '@/lib/user-visit';
import { pickGreeting, pickHomeGreeting } from './greeting';

export function Welcome({ name }: { name: string | undefined }) {
  return pickGreeting(name, useFirstSession());
}

export function HomeWelcome({ name }: { name: string | undefined }) {
  const firstSession = useFirstSession();
  // One random draw per visit, so the greeting changes each time the home opens but not on re-render.
  const [draws] = useState(() => [Math.random(), Math.random()]);
  const [now] = useState(() => new Date());
  const greeting = useMemo(() => {
    let index = 0;
    return pickHomeGreeting(name, firstSession, now, () => draws[index++ % draws.length]!);
  }, [name, firstSession, now, draws]);
  // Starting empty lets the subtitle type itself in once the page opens.
  const [subtitle, setSubtitle] = useState('');
  useEffect(() => setSubtitle(greeting.subtitle), [greeting.subtitle]);
  return (
    <hgroup className="home-greeting isolate space-y-2">
      <h2 className="text-4xl font-semibold tracking-tight sm:text-5xl">
        {greeting.before}
        {greeting.name && (
          <span className="bg-linear-to-r from-primary-text to-primary bg-clip-text pb-1 text-transparent">
            {greeting.name}
          </span>
        )}
        {greeting.after}
      </h2>
      <p className="min-h-8 text-2xl font-medium tracking-tight text-muted-foreground sm:min-h-9 sm:text-3xl">
        <TypedText text={subtitle} />
      </p>
    </hgroup>
  );
}
