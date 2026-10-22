import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { GovernanceSnapshot } from '@tulipfarm/workspaces/governance-contracts';
import { EntityAvatar } from '@tulipfarm/sprout/avatar';
import { PresenceCursor } from '@tulipfarm/sprout/presence-cursor';
import { hash } from '@/lib/hash';
import type { RecipientRow } from '@/lib/invitation-batch';
import './invite-members-canvas.css';

type Member = GovernanceSnapshot['directory'][number];
type Person = { id: string; name: string; x: number; y: number; avatar?: ReactNode };
type Size = { width: number; height: number };

const colors = ['var(--invite-cursor-1)', 'var(--invite-cursor-2)', 'var(--invite-cursor-3)', 'var(--invite-cursor-4)'];
const visible = 12;
/** Room kept free right of and below each arrow tip for its tag. */
const tag = { width: 200, height: 44 };
const drift = 20;
/** Motion stops before 5s (WCAG 2.2.2), so the board needs no pause control. */
const wanderFor = 4800;

function useMotionAllowed() {
  const [reduced, setReduced] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [hidden, setHidden] = useState(() => document.hidden);
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const motion = () => setReduced(query.matches);
    const visibility = () => setHidden(document.hidden);
    query.addEventListener('change', motion);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      query.removeEventListener('change', motion);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, []);
  return !reduced && !hidden;
}

/** Nudges every cursor to a nearby spot every 1.6s for a short burst whenever the people change. */
function useWander(ids: string[], moving: boolean) {
  const [offsets, setOffsets] = useState<Record<string, { x: number; y: number }>>({});
  const key = ids.join('\0');
  useEffect(() => {
    if (!moving) return;
    const id = window.setInterval(
      () =>
        setOffsets(current =>
          Object.fromEntries(
            key.split('\0').map(person => {
              const { x = 0, y = 0 } = current[person] ?? {};
              const step = () => (Math.random() - 0.5) * drift;
              return [
                person,
                {
                  x: Math.max(-drift, Math.min(drift, x + step())),
                  y: Math.max(-drift, Math.min(drift, y + step())),
                },
              ];
            }),
          ),
        ),
      1600,
    );
    const stop = window.setTimeout(() => window.clearInterval(id), wanderFor);
    return () => {
      window.clearInterval(id);
      window.clearTimeout(stop);
    };
  }, [key, moving]);
  return offsets;
}

/** Lays people out in two staggered columns, with a stable jitter per person. */
function spot(id: string, index: number, count: number, size: Size) {
  const seed = hash(id);
  const column = index % 2;
  const band = (size.height - tag.height - drift * 2) / Math.max(1, Math.ceil(count / 2));
  return {
    x: Math.min(size.width - tag.width, size.width * (column ? 0.46 : 0.04) + (seed % 20)),
    y: drift + band * Math.floor(index / 2) + (column ? band / 2 : 0) + ((seed >> 5) % 12),
  };
}

function Cursors({ people }: { people: Person[] }) {
  return people.map(person => (
    <li key={person.id}>
      <PresenceCursor
        name={person.name}
        color={colors[hash(person.id) % colors.length]!}
        x={person.x}
        y={person.y}
        avatar={person.avatar}
      />
    </li>
  ));
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
  const [size, setSize] = useState<Size>({ width: 0, height: 0 });
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
  const shown = emails.slice(0, visible - sample.length);
  const count = sample.length + shown.length;
  const moving = useMotionAllowed();
  const offsets = useWander([...sample.map(member => member.id), ...shown], moving && count > 0);
  const place = (id: string, index: number) => {
    const base = spot(id, index, count, size);
    const nudge = offsets[id] ?? { x: 0, y: 0 };
    return {
      x: Math.max(0, Math.min(size.width - tag.width, base.x + nudge.x)),
      y: Math.max(0, Math.min(size.height - tag.height, base.y + nudge.y)),
    };
  };
  const existing = sample.map((member, index) => ({
    id: member.id,
    name: member.name || member.email,
    avatar: <EntityAvatar seed={member.id} name={member.name || member.email} image={member.image} size="sm" />,
    ...place(member.id, index),
  }));
  const invited = shown.map((email, index) => ({ id: email, name: email, ...place(email, sample.length + index) }));
  return (
    <aside className="invite-canvas" aria-label="Member canvas">
      <h3 className="text-sm font-medium">Your workspace, together</h3>
      <p className="sr-only">An illustration of your team, not live online activity.</p>
      <div
        className="invite-board"
        ref={node => {
          if (!node) return;
          const observer = new ResizeObserver(([entry]) =>
            setSize({ width: entry!.contentRect.width, height: entry!.contentRect.height }),
          );
          observer.observe(node);
          return () => observer.disconnect();
        }}
      >
        {size.width > 0 && (
          <>
            {existing.length > 0 && (
              <section aria-label="Already in your workspace">
                <ul>
                  <Cursors people={existing} />
                </ul>
              </section>
            )}
            <section aria-label="People to invite">
              {invited.length > 0 ? (
                <ul>
                  <Cursors people={invited} />
                </ul>
              ) : (
                <p className="invite-board-note text-sm text-muted-foreground">
                  Add email addresses to see your invites here.
                </p>
              )}
              {emails.length > shown.length && (
                <p className="invite-board-note text-sm text-muted-foreground">
                  And {emails.length - shown.length} more
                </p>
              )}
            </section>
          </>
        )}
      </div>
    </aside>
  );
}
