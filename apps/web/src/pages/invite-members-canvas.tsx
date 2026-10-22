import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { MousePointer2, Pause, Play } from 'lucide-react';
import type { GovernanceSnapshot } from '@tulipfarm/workspaces/governance-contracts';
import { EntityAvatar } from '@tulipfarm/sprout/avatar';
import { Button } from '@tulipfarm/sprout/button';
import { hash } from '@/lib/hash';
import type { RecipientRow } from '@/lib/invitation-batch';
import './invite-members-canvas.css';

type Member = GovernanceSnapshot['directory'][number];
const positions = [
  [3, 8],
  [2, 174],
  [4, 356],
  [53, 42],
  [28, 292],
  [23, 108],
  [55, 226],
  [53, 408],
] as const;

function Person({
  id,
  name,
  image,
  member,
  index,
}: {
  id: string;
  name: string;
  image?: string | null | undefined;
  member: boolean;
  index: number;
}) {
  const seed = hash(id);
  const [x, y] = positions[index % positions.length]!;
  const style = {
    '--person-x': `${x + (seed % 3)}%`,
    '--person-y': `${y + Math.floor(index / positions.length) * 480 + (seed % 9)}px`,
    '--person-drift-x': `${seed % 2 ? 7 : -7}px`,
    '--person-drift-y': `${seed % 3 ? -6 : 6}px`,
    '--person-duration': `${9 + (seed % 6)}s`,
    '--person-delay': `${-(seed % 10)}s`,
  } as CSSProperties;
  return (
    <li className="invite-person" data-tone={seed % 5} data-animated={index < 16} style={style}>
      <div className="invite-person-motion">
        <MousePointer2 size={21} fill="currentColor" aria-hidden="true" />
        <div className="invite-person-label" data-member={member}>
          {member && <EntityAvatar seed={id} name={name} image={image} size="sm" />}
          <span className="truncate text-sm font-medium" title={name}>
            {name}
          </span>
        </div>
      </div>
    </li>
  );
}

export function InviteMembersCanvas({
  members,
  recipients,
  rows,
}: {
  members: Member[];
  recipients: string[];
  rows: RecipientRow[];
}) {
  const canvas = useRef<HTMLElement>(null);
  const [paused, setPaused] = useState(false);
  const sample = useMemo(
    () =>
      members
        .map(member => ({ member, order: Math.random() }))
        .sort((a, b) => a.order - b.order)
        .slice(0, 3)
        .map(({ member }) => member),
    [members],
  );
  const emails = [...new Set([...recipients, ...rows.map(row => row.email)])];
  const peopleKey = [...sample.map(member => member.id), ...emails].join('\0');
  const count = sample.length + emails.length;
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const visibility = () => {
      element.dataset.hidden = String(document.hidden);
    };
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (entry.target instanceof HTMLElement) entry.target.dataset.visible = String(entry.isIntersecting);
      }
    });
    for (const person of element.querySelectorAll('.invite-person')) observer.observe(person);
    visibility();
    document.addEventListener('visibilitychange', visibility);
    return () => {
      observer.disconnect();
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [peopleKey]);
  return (
    <aside ref={canvas} className="invite-canvas" aria-label="Member canvas" data-paused={paused}>
      <header className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-medium">Your workspace, together</h3>
        {count > 0 && (
          <div className="invite-motion-control">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={paused ? 'Resume movement' : 'Pause movement'}
              onClick={() => setPaused(value => !value)}
            >
              {paused ? <Play size={14} aria-hidden="true" /> : <Pause size={14} aria-hidden="true" />}
            </Button>
          </div>
        )}
      </header>
      <p className="sr-only">An illustration of your team, not live online activity.</p>
      <div
        className="invite-presence-field"
        style={{ '--presence-height': `${Math.max(1, Math.ceil(count / positions.length)) * 480}px` } as CSSProperties}
      >
        {sample.length > 0 && (
          <section className="invite-presence-group" aria-label="Already in your workspace">
            <ul className="invite-presence-group">
              {sample.map((member, index) => (
                <Person
                  key={member.id}
                  id={member.id}
                  name={member.name || member.email}
                  image={member.image}
                  member
                  index={index}
                />
              ))}
            </ul>
          </section>
        )}
        <section className="invite-presence-group" aria-label="People to invite">
          {emails.length === 0 ? (
            <p className="invite-canvas-empty text-sm text-muted-foreground">
              Add email addresses to see your invites here.
            </p>
          ) : (
            <ul className="invite-presence-group">
              {emails.map((email, index) => {
                const member = members.find(person => person.email.toLowerCase() === email.toLowerCase());
                return (
                  <Person
                    key={email}
                    id={email}
                    name={member?.name || email}
                    image={member?.image}
                    member={Boolean(member)}
                    index={sample.length + index}
                  />
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </aside>
  );
}
