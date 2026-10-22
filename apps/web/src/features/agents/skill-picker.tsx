import { useMemo, useState } from 'react';
import { z } from 'zod';
import { procedureSelectionsSchema } from '@tulipfarm/agents/workspace-skill-contracts';
import { Button } from '@tulipfarm/sprout/button';
import { ChoiceGroup } from '@tulipfarm/sprout/field';
import { FormSection } from '@tulipfarm/sprout/form';
import { Skeleton } from '@tulipfarm/sprout/skeleton';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { Badge } from '@tulipfarm/sprout/badge';
import { SearchField } from '@tulipfarm/sprout/search-field';
import { Disclosure } from '@/components/disclosure';
import { useReviewedSkills, useSkillDetail } from '@/features/skills/queries';
import { skillApi, type SkillDetail } from '@/features/skills/api';
import type { ReadState } from '@/features/tables/request-state';

export type SkillSelections = z.infer<typeof procedureSelectionsSchema>;
const skillLimit = 16;
type Api = ReturnType<typeof skillApi>;
export type SkillOption = { id: string; name: string; description: string; revision: string };
type Skill = SkillOption;
export function AgentSkillPicker({
  workspaceId,
  value,
  onChange,
  disabled,
  builtins = [],
  onImport,
}: {
  workspaceId: string;
  value: SkillSelections;
  onChange: (value: SkillSelections) => void;
  disabled: boolean;
  builtins?: readonly SkillOption[] | undefined;
  onImport?: (() => void) | undefined;
}) {
  const api = useMemo(() => skillApi(workspaceId), [workspaceId]);
  const [after, setAfter] = useState<string>();
  const [search, setSearch] = useState('');
  const read = useReviewedSkills(api, after, search);
  const workspace = read.state.kind === 'ready' ? read.state.data.workspace : [];
  const available = [...builtins, ...workspace];
  const matchedBuiltins = builtins.filter(item =>
    `${item.name} ${item.description}`.toLowerCase().includes(search.trim().toLowerCase()),
  );
  const selected = value.map(item => item.id);
  const full = value.length >= skillLimit;
  const catalogBlocked = disabled || read.state.kind !== 'ready' || read.state.refreshing || !!read.state.error;
  const choose = (ids: string[]) =>
    onChange(
      ids.flatMap(id => {
        const pinned = value.find(selection => selection.id === id);
        if (pinned) return [pinned];
        const item = available.find(option => option.id === id);
        return item ? [{ id, revision: item.revision }] : [];
      }),
    );
  return (
    <FormSection
      title="Skills"
      label="Agent skills"
      meta={`${value.length} of ${skillLimit}`}
      description="Step-by-step procedures this agent can follow."
    >
      {value.length > 0 && (
        <ul aria-label="Selected skills" className="min-w-0 divide-y rounded-lg border">
          {value.map(selection => (
            <SelectedSkill
              key={selection.id}
              api={api}
              selection={selection}
              catalog={available.find(item => item.id === selection.id)}
              disabled={disabled}
              catalogBlocked={catalogBlocked}
              onUpgrade={newer =>
                onChange(value.map(item => (item.id === newer.id ? { id: newer.id, revision: newer.revision } : item)))
              }
              onRemove={() => onChange(value.filter(item => item.id !== selection.id))}
            />
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1">
          <SearchField
            id="agent-skill-search"
            label="Find skills"
            placeholder="Search skills"
            maxLength={120}
            value={search}
            onChange={next => {
              setSearch(next);
              setAfter(undefined);
            }}
          />
        </div>
        {onImport && (
          <Button variant="outline" disabled={disabled} onClick={onImport}>
            Import skill
          </Button>
        )}
      </div>
      {matchedBuiltins.length > 0 && (
        <ChoiceGroup
          type="checkbox"
          optional
          legend="Built-in skills"
          disabled={disabled}
          helper="Included with TulipFarm. Skills guide the work; they do not grant access."
          options={matchedBuiltins.map(item => ({
            value: item.id,
            label: item.name,
            description: item.description,
            disabled: full && !selected.includes(item.id),
          }))}
          value={selected}
          onValueChange={choose}
        />
      )}
      {read.state.kind === 'loading' ? (
        <div role="status" aria-label="Loading reviewed skills" className="space-y-2">
          <Skeleton />
          <Skeleton />
          <span className="sr-only">Loading reviewed skills…</span>
        </div>
      ) : read.state.kind === 'error' || read.state.kind === 'unavailable' ? (
        <div className="space-y-3">
          <Alert variant="destructive">
            <AlertDescription>Could not load reviewed skills. Existing selections are retained.</AlertDescription>
          </Alert>
          <Button variant="outline" onClick={() => void read.refresh()}>
            Retry skill catalog
          </Button>
        </div>
      ) : (
        <div className="grid gap-3">
          {read.state.error && (
            <Alert variant="destructive">
              <AlertDescription>The catalog refresh failed. Existing selections are retained.</AlertDescription>
            </Alert>
          )}
          {workspace.length ? (
            <div className="min-w-0 wrap-anywhere">
              <ChoiceGroup
                type="checkbox"
                layout="columns"
                optional
                legend="Available skills"
                disabled={catalogBlocked}
                helper={
                  full
                    ? `You've chosen ${skillLimit} skills. Remove one to add another.`
                    : `Choose up to ${skillLimit}.`
                }
                options={workspace.map(item => ({
                  value: item.id,
                  label: item.name,
                  description: item.description,
                  disabled: full && !selected.includes(item.id),
                }))}
                value={selected}
                onValueChange={choose}
              />
            </div>
          ) : search ? (
            <div className="grid gap-2">
              <p className="text-sm text-muted-foreground">No reviewed workspace skills match this search.</p>
              <div>
                <Button variant="outline" onClick={() => setSearch('')}>
                  Clear search
                </Button>
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              No reviewed workspace skills yet. Import a skill or review one in Skills.
            </p>
          )}
          {(after || read.state.data.nextCursor) && (
            <nav aria-label="Skill pages" className="flex flex-wrap gap-2">
              {after && (
                <Button variant="outline" size="sm" onClick={() => setAfter(undefined)}>
                  First skill page
                </Button>
              )}
              {read.state.data.nextCursor && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    setAfter(read.state.kind === 'ready' ? (read.state.data.nextCursor ?? undefined) : undefined)
                  }
                >
                  Next skill page
                </Button>
              )}
            </nav>
          )}
        </div>
      )}
    </FormSection>
  );
}

const uuid = z.uuid();
const pinnedName = (detail: SkillDetail) => detail.reviewedDefinition?.name ?? detail.definition.name;

function SelectedSkill({
  api,
  selection,
  catalog,
  disabled,
  catalogBlocked,
  onUpgrade,
  onRemove,
}: {
  api: Api;
  selection: SkillSelections[number];
  catalog: Skill | undefined;
  disabled: boolean;
  catalogBlocked: boolean;
  onUpgrade: (newer: Skill) => void;
  onRemove: () => void;
}) {
  const lookup = catalog === undefined && uuid.safeParse(selection.id).success;
  const pinned = useSkillDetail(api, selection.id, lookup);
  const label =
    catalog?.name ?? (lookup && pinned.state.kind === 'ready' ? pinnedName(pinned.state.data) : selection.id);
  return (
    <li className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-3 py-2">
      <div className="min-w-0 flex-1 basis-40 space-y-0.5">
        {catalog === undefined ? (
          <PinnedSkillName id={selection.id} state={lookup ? pinned.state : null} retry={() => void pinned.refresh()} />
        ) : (
          <p className="break-words text-sm text-foreground">{catalog.name}</p>
        )}
        {uuid.safeParse(selection.id).success ? (
          <Disclosure title="Version details">
            <p className="break-all font-mono text-xs text-muted-foreground">Selected revision {selection.revision}</p>
          </Disclosure>
        ) : (
          <p className="text-xs text-muted-foreground">Built-in procedure</p>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-1">
        {catalog && catalog.revision !== selection.revision && (
          <Button
            type="button"
            variant="link"
            size="sm"
            aria-label={`Select newer revision of ${catalog.name}`}
            disabled={catalogBlocked}
            onClick={() => onUpgrade(catalog)}
          >
            Select newer revision
          </Button>
        )}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={`Remove skill ${label}`}
          disabled={disabled}
          onClick={onRemove}
        >
          Remove
        </Button>
      </div>
    </li>
  );
}

function PinnedSkillName({
  id,
  state,
  retry,
}: {
  id: string;
  state: ReadState<SkillDetail> | null;
  retry: () => void;
}) {
  if (state?.kind === 'loading') return <p className="text-sm text-muted-foreground">Loading skill name…</p>;
  if (state?.kind === 'error')
    return (
      <Button type="button" variant="outline" size="sm" onClick={retry}>
        Retry skill name
      </Button>
    );
  if (state?.kind === 'ready')
    return (
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-foreground">
        <span className="min-w-0 break-words">{pinnedName(state.data)}</span>
        {state.data.lifecycle === 'archived' && <Badge variant="secondary">Archived</Badge>}
        {state.data.management?.enabled === false && <Badge variant="warning">Disabled</Badge>}
      </p>
    );
  return (
    <p className="flex flex-wrap items-baseline gap-x-2 text-sm text-foreground">
      <span>Unavailable skill</span>
      <span className="break-all font-mono text-xs text-muted-foreground">{id}</span>
    </p>
  );
}
