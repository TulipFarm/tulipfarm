import { useState, type ReactNode } from 'react';
import { GitBranchIcon, UserCircleIcon } from '@tulipfarm/icons';
import { AgentMark } from '@/components/agent-mark';
import { EntityAvatar } from '@tulipfarm/sprout/avatar';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@tulipfarm/sprout/command';
import { Popover, PopoverContent, PopoverTrigger } from '@tulipfarm/sprout/popover';
import { Status, type StatusState } from '@tulipfarm/sprout/status';
import { Chip, PropertyChip } from '@/components/ui/chip';
import {
  actorImage,
  actorKey,
  actorLabel,
  parseActorKey,
  useActorDirectory,
  type Actor,
} from '@/features/tables/actors';
import { optionLabel, type TaskOption } from './task-data';

/** `chip` is a composer pill; `property` is a flat value in the task page's side panel. */
export type ChipLook = 'chip' | 'property';

export type MenuChoice = {
  value: string;
  label: string;
  icon?: ReactNode;
  keywords?: string[] | undefined;
  group?: string | undefined;
  disabled?: boolean | undefined;
};

/** A chip that opens a searchable menu of choices and closes when one is picked. */
export function ChipMenu({
  look,
  name,
  icon,
  text,
  placeholder,
  title,
  disabled,
  choices,
  value,
  pick,
  searchable = true,
}: {
  look: ChipLook;
  /** What the chip sets, such as "Assignee"; it names the button and the search. */
  name: string;
  icon: ReactNode;
  text: string;
  placeholder: boolean;
  title?: string | undefined;
  disabled?: boolean | undefined;
  choices: readonly MenuChoice[];
  value: string;
  pick: (value: string) => void;
  searchable?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const trigger =
    look === 'chip' ? (
      <Chip
        icon={icon}
        placeholder={placeholder}
        disabled={disabled}
        title={title ?? name}
        aria-label={`${name}: ${text}`}
      />
    ) : (
      <PropertyChip
        icon={icon}
        placeholder={placeholder}
        disabled={disabled}
        title={title}
        aria-label={`${name}: ${text}`}
      />
    );
  const groups = [...new Set(choices.map(choice => choice.group ?? ''))];
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={trigger}>{text}</PopoverTrigger>
      <PopoverContent size="picker" align="start" sideOffset={4}>
        <Command label={name} loop>
          {searchable && <CommandInput aria-label={`Search ${name.toLowerCase()}`} placeholder={`${name}…`} />}
          <CommandList aria-label={name}>
            <CommandEmpty>Nothing matches.</CommandEmpty>
            {groups.map(group => (
              <CommandGroup key={group} heading={group || undefined}>
                {choices
                  .filter(choice => (choice.group ?? '') === group)
                  .map(choice => (
                    <CommandItem
                      key={choice.value}
                      value={choice.value || '-'}
                      keywords={[choice.label, ...(choice.keywords ?? [])]}
                      disabled={choice.disabled ?? false}
                      data-checked={choice.value === value}
                      onSelect={() => {
                        setOpen(false);
                        if (choice.value !== value) pick(choice.value);
                      }}
                    >
                      {choice.icon}
                      <span className="min-w-0 truncate">{choice.label}</span>
                    </CommandItem>
                  ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

export const statusIcon = (state: StatusState) => <Status state={state} size="sm" aria-hidden="true" tooltip={false} />;

export function ActorAvatar({ actor, name, image = null }: { actor: Actor; name: string; image?: string | null }) {
  return actor.type === 'agent' ? (
    <AgentMark agentId={actor.id} size={24} />
  ) : (
    <EntityAvatar seed={actor.id} name={name} image={image} size="sm" />
  );
}

/** Picks a person or, unless `peopleOnly`, an agent, with avatars and search. */
export function ActorMenu({
  workspaceId,
  look,
  name,
  value,
  change,
  disabled,
  peopleOnly = false,
}: {
  workspaceId: string;
  look: ChipLook;
  name: string;
  value: Actor | null;
  change: (actor: Actor | null) => void;
  disabled?: boolean | undefined;
  peopleOnly?: boolean;
}) {
  const directory = useActorDirectory(workspaceId);
  const data = directory.state.kind === 'ready' ? directory.state.data : undefined;
  const label = value ? actorLabel(data, value) : look === 'chip' ? name : 'Not set';
  const none = `No ${name.toLowerCase()}`;
  const choices: MenuChoice[] = [
    { value: '', label: none, icon: <UserCircleIcon size="sm" aria-hidden="true" /> },
    ...(data?.members ?? [])
      .filter(member => member.current)
      .map(member => {
        const actor: Actor = { type: 'member', id: member.membershipId };
        return {
          value: actorKey(actor),
          label: member.name,
          keywords: member.email ? [member.email] : [],
          icon: <ActorAvatar actor={actor} name={member.name} image={actorImage(workspaceId, data, actor)} />,
          group: peopleOnly ? undefined : 'People',
        };
      }),
    ...(peopleOnly ? [] : (data?.agents ?? []))
      .filter(agent => agent.available)
      .map(agent => {
        const actor: Actor = { type: 'agent', id: agent.id };
        return {
          value: actorKey(actor),
          label: agent.name,
          icon: <ActorAvatar actor={actor} name={agent.name} />,
          group: 'Agents',
        };
      }),
  ];
  return (
    <ChipMenu
      look={look}
      name={name}
      icon={
        value ? (
          <ActorAvatar actor={value} name={label} image={actorImage(workspaceId, data, value)} />
        ) : (
          <UserCircleIcon size="sm" aria-hidden="true" />
        )
      }
      text={data || !value ? label : 'Loading…'}
      placeholder={!value}
      disabled={disabled || !data}
      choices={choices}
      value={value ? actorKey(value) : ''}
      pick={next => change(next ? parseActorKey(next) : null)}
    />
  );
}

/** Picks a parent task from the tasks loaded on the board. */
export function ParentMenu({
  look,
  tasks,
  value,
  change,
  disabled,
}: {
  look: ChipLook;
  tasks: readonly TaskOption[];
  value: string | null;
  change: (parent: string | null) => void;
  disabled?: boolean | undefined;
}) {
  const chosen = tasks.find(task => task.id === value);
  const text = chosen ? optionLabel(chosen) : value ? 'Older task' : look === 'chip' ? 'Parent task' : 'Not set';
  return (
    <ChipMenu
      look={look}
      name="Parent task"
      icon={<GitBranchIcon size="sm" aria-hidden="true" />}
      text={text}
      placeholder={!value}
      disabled={disabled}
      choices={[
        { value: '', label: 'No parent task' },
        ...tasks.map(task => ({ value: task.id, label: optionLabel(task), keywords: task.key ? [task.key] : [] })),
      ]}
      value={value ?? ''}
      pick={next => change(next || null)}
    />
  );
}
