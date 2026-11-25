import { z } from 'zod';
import { AgentAvatar } from '@tulipfarm/sprout/agent-avatar';
import { EntityAvatar } from '@tulipfarm/sprout/avatar';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@tulipfarm/sprout/select';
import { apiOrigin } from '@/lib/auth';
import { jsonResponse, readJson, responseError } from '@/lib/http';
import { useFeatureRead } from '@/lib/query';
import { TableRequestError } from './request-state';

export const actorDirectorySchema = z.object({
  members: z.array(
    z.object({ membershipId: z.uuid(), name: z.string(), email: z.string().nullable(), current: z.boolean() }),
  ),
  agents: z.array(z.object({ id: z.uuid(), name: z.string(), available: z.boolean() })),
});
export type ActorDirectory = z.infer<typeof actorDirectorySchema>;
export type Actor = { type: 'member' | 'agent'; id: string };

export const actorKeys = { directory: (workspaceId: string) => ['tables', 'actors', workspaceId] as const };

export function actorsApi(workspaceId: string) {
  return {
    async directory(signal: AbortSignal) {
      const response = await jsonResponse(`${apiOrigin}/v1/workspaces/${encodeURIComponent(workspaceId)}/actors`, {
        signal,
        cache: 'no-store',
      });
      const value = await readJson(response, true);
      if (!response.ok)
        throw new TableRequestError(
          response.status,
          responseError(value, 'actors-unavailable'),
          'People and agents could not be loaded. Try again.',
        );
      return actorDirectorySchema.parse(value);
    },
  };
}

/** Everyone a row can be assigned to, and the names of former members and deleted agents still shown on rows. */
export function useActorDirectory(workspaceId: string, enabled = true) {
  return useFeatureRead({ key: actorKeys.directory(workspaceId), enabled, load: actorsApi(workspaceId).directory });
}

export function actorKey(actor: Actor) {
  return `${actor.type}:${actor.id}`;
}

export function parseActorKey(key: string): Actor | null {
  const match = /^(member|agent):([0-9a-f-]{36})$/i.exec(key);
  return match ? { type: match[1] as Actor['type'], id: match[2]!.toLowerCase() } : null;
}

export function actorLabel(directory: ActorDirectory | undefined, actor: Actor) {
  if (actor.type === 'member') {
    const member = directory?.members.find(item => item.membershipId === actor.id);
    if (!directory) return 'Person';
    return member?.current ? member.name : 'Former member';
  }
  const agent = directory?.agents.find(item => item.id === actor.id);
  if (!directory) return 'Agent';
  return agent ? agent.name : 'Deleted agent';
}

export function ActorName({
  workspaceId,
  actor,
  compact = false,
}: {
  workspaceId: string;
  actor: Actor;
  compact?: boolean;
}) {
  const directory = useActorDirectory(workspaceId);
  const data = directory.state.kind === 'ready' ? directory.state.data : undefined;
  const label = actorLabel(data, actor);
  const missing = label === 'Former member' || label === 'Deleted agent';
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span aria-hidden="true" className="flex shrink-0">
        {actor.type === 'agent' ? (
          <AgentAvatar agentId={actor.id} name={label} size="sm" />
        ) : (
          <EntityAvatar seed={actor.id} name={label} size="sm" />
        )}
      </span>
      <span
        title={label}
        className={`${compact ? 'block max-w-64 truncate' : 'wrap-anywhere'} ${missing ? 'text-muted-foreground' : ''}`}
      >
        {label}
      </span>
    </span>
  );
}

/** Picks one current member or available agent. A former member or deleted agent stays shown until changed. */
export function ActorPicker({
  workspaceId,
  value,
  disabled,
  change,
  label = 'Person or agent',
  size,
  width = 'full',
  empty = 'Not set',
  peopleOnly = false,
}: {
  workspaceId: string;
  value: Actor | null;
  disabled: boolean;
  change: (actor: Actor | null) => void;
  label?: string;
  size?: 'sm' | 'md';
  width?: 'fit' | 'full';
  /** What the closed picker shows when nobody is chosen, such as the field name. */
  empty?: string;
  peopleOnly?: boolean;
}) {
  const directory = useActorDirectory(workspaceId);
  const data = directory.state.kind === 'ready' ? directory.state.data : undefined;
  const current = value ? actorKey(value) : '';
  const members = data?.members.filter(member => member.current) ?? [];
  const agents = peopleOnly ? [] : (data?.agents.filter(agent => agent.available) ?? []);
  return (
    <Select
      value={current}
      disabled={disabled || !data}
      onValueChange={next => change(next ? parseActorKey(next) : null)}
    >
      <SelectTrigger width={width} size={size ?? 'md'} aria-label={label}>
        <SelectValue>
          {value ? actorLabel(data, value) : directory.state.kind === 'ready' ? empty : 'Loading…'}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="">Not set</SelectItem>
        {members.length > 0 && (
          <SelectGroup>
            <SelectLabel>People</SelectLabel>
            {members.map(member => (
              <SelectItem key={member.membershipId} value={`member:${member.membershipId}`}>
                {member.name}
              </SelectItem>
            ))}
          </SelectGroup>
        )}
        {agents.length > 0 && (
          <SelectGroup>
            <SelectLabel>Agents</SelectLabel>
            {agents.map(agent => (
              <SelectItem key={agent.id} value={`agent:${agent.id}`}>
                {agent.name}
              </SelectItem>
            ))}
          </SelectGroup>
        )}
      </SelectContent>
    </Select>
  );
}
