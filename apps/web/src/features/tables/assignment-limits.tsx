import { useEffect, useMemo, useState } from 'react';
import { z } from 'zod';
import { Button } from '@tulipfarm/sprout/button';
import { Input } from '@tulipfarm/sprout/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tulipfarm/sprout/select';
import { SettingsGroup, SettingsRow } from '@tulipfarm/sprout/settings-list';
import { apiOrigin } from '@/lib/auth';
import { jsonResponse, readJson } from '@/lib/http';

const credits = z.number().int().min(1).max(1_000_000).nullable();
const limitsSchema = z.object({
  workspace: z.number().int().min(1).max(100),
  timeZone: z.string(),
  dailyCredits: credits,
  agents: z.array(
    z.object({
      agentId: z.uuid(),
      name: z.string(),
      concurrent: z.number().int().min(1).max(20),
      dailyRuns: z.number().int().min(1).max(10000).nullable(),
      dailyCredits: credits,
    }),
  ),
});
type Limits = z.infer<typeof limitsSchema>;

function limitsApi(workspaceId: string) {
  const url = `${apiOrigin}/v1/workspaces/${encodeURIComponent(workspaceId)}/assignment-limits`;
  async function request(signal: AbortSignal, body?: unknown) {
    const response = await jsonResponse(url, {
      method: body ? 'PUT' : 'GET',
      signal,
      cache: 'no-store',
      ...(body ? { body } : {}),
    });
    if (!response.ok) throw new Error('assignment-limits-failed');
    return limitsSchema.parse(await readJson(response));
  }
  return {
    read: (signal: AbortSignal) => request(signal),
    save: (limits: Limits, signal: AbortSignal) =>
      request(signal, {
        workspace: limits.workspace,
        timeZone: limits.timeZone,
        dailyCredits: limits.dailyCredits,
        agents: limits.agents.map(({ agentId, concurrent, dailyRuns, dailyCredits }) => ({
          agentId,
          concurrent,
          dailyRuns,
          dailyCredits,
        })),
      }),
  };
}

const whole = (text: string, min: number, max: number) => {
  const value = Number(text);
  return Number.isInteger(value) && value >= min && value <= max ? value : null;
};
/** An empty box means no cap; anything else must be a whole number in range. */
const optional = (text: string | undefined, max: number) => {
  const trimmed = text?.trim() ?? '';
  if (!trimmed) return { value: null, invalid: false };
  const value = whole(trimmed, 1, max);
  return { value, invalid: value === null };
};
const zones = (current: string) => {
  const known = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
  return [...new Set(['UTC', current, ...known])];
};

/** Admin caps on assigned rows: how many agents work at once, and the runs and credits they use each day. */
export function AssignmentLimitsSettings({ workspaceId, agentId }: { workspaceId: string; agentId?: string }) {
  const api = useMemo(() => limitsApi(workspaceId), [workspaceId]);
  const [saved, setSaved] = useState<Limits | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const fill = (limits: Limits) => {
    setSaved(limits);
    setDraft({
      workspace: String(limits.workspace),
      timeZone: limits.timeZone,
      credits: limits.dailyCredits === null ? '' : String(limits.dailyCredits),
      ...Object.fromEntries(
        limits.agents.flatMap(agent => [
          [`${agent.agentId}:concurrent`, String(agent.concurrent)],
          [`${agent.agentId}:daily`, agent.dailyRuns === null ? '' : String(agent.dailyRuns)],
          [`${agent.agentId}:credits`, agent.dailyCredits === null ? '' : String(agent.dailyCredits)],
        ]),
      ),
    });
  };
  useEffect(() => {
    const controller = new AbortController();
    api
      .read(controller.signal)
      .then(fill)
      .catch(() => {
        if (!controller.signal.aborted) setError('Couldn’t load assignment limits. Refresh to try again.');
      });
    return () => controller.abort();
  }, [api]);
  if (!saved && !error) return null;
  if (agentId && saved && !saved.agents.some(agent => agent.agentId === agentId)) return null;
  const workspaceCredits = optional(draft.credits, 1_000_000);
  const next = saved && {
    workspace: whole(draft.workspace ?? '', 1, 100),
    timeZone: draft.timeZone ?? saved.timeZone,
    dailyCredits: workspaceCredits.value,
    agents: saved.agents.map(agent => {
      const runs = optional(draft[`${agent.agentId}:daily`], 10000);
      const spend = optional(draft[`${agent.agentId}:credits`], 1_000_000);
      return {
        ...agent,
        concurrent: whole(draft[`${agent.agentId}:concurrent`] ?? '', 1, 20),
        dailyRuns: runs.value,
        dailyCredits: spend.value,
        dailyInvalid: runs.invalid || spend.invalid,
      };
    }),
  };
  const invalid =
    !next ||
    next.workspace === null ||
    workspaceCredits.invalid ||
    next.agents.some(agent => agent.concurrent === null || agent.dailyInvalid);
  const field = (key: string, label: string, placeholder?: string) => (
    <Input
      aria-label={label}
      inputMode="numeric"
      value={draft[key] ?? ''}
      placeholder={placeholder}
      disabled={saving}
      onChange={event => {
        setNotice(null);
        setDraft(previous => ({ ...previous, [key]: event.target.value }));
      }}
    />
  );
  return (
    <SettingsGroup title="Assigned rows" titleId="assignment-limits-heading">
      {!agentId && (
        <>
          <SettingsRow
            label="Agents working at once"
            description="The most assigned rows all agents in this workspace work on at the same time. 1 to 100."
          >
            {saved && field('workspace', 'Agents working at once')}
          </SettingsRow>
          <SettingsRow
            label="Credits a day"
            description="The most credits assigned work in this workspace uses each day. Leave empty for no daily cap."
          >
            {saved && field('credits', 'Credits a day', 'No cap')}
          </SettingsRow>
          <SettingsRow label="Day starts in" description="Daily runs and credits reset at midnight in this time zone.">
            {saved && (
              <Select
                value={draft.timeZone ?? saved.timeZone}
                disabled={saving}
                onValueChange={value => {
                  if (!value) return;
                  setNotice(null);
                  setDraft(previous => ({ ...previous, timeZone: value }));
                }}
                items={zones(saved.timeZone).map(zone => ({ value: zone, label: zone.replaceAll('_', ' ') }))}
              >
                <SelectTrigger aria-label="Day starts in">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {zones(saved.timeZone).map(zone => (
                    <SelectItem key={zone} value={zone}>
                      {zone.replaceAll('_', ' ')}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </SettingsRow>
        </>
      )}
      {saved?.agents
        .filter(agent => !agentId || agent.agentId === agentId)
        .map(agent => (
          <SettingsRow
            key={agent.agentId}
            label={agent.name}
            description="Rows this agent works on at once (1 to 20), then its runs and credits a day. Leave a daily box empty for no cap."
          >
            <div className="flex gap-2">
              {field(`${agent.agentId}:concurrent`, `${agent.name}, rows at once`)}
              {field(`${agent.agentId}:daily`, `${agent.name}, runs a day`, 'No cap')}
              {field(`${agent.agentId}:credits`, `${agent.name}, credits a day`, 'No cap')}
            </div>
          </SettingsRow>
        ))}
      {saved && (
        <div className="flex items-center gap-3">
          <Button
            disabled={saving || invalid}
            onClick={() => {
              if (!next || invalid || next.workspace === null) return;
              setSaving(true);
              setError(null);
              api
                .save(
                  {
                    workspace: next.workspace,
                    timeZone: next.timeZone,
                    dailyCredits: next.dailyCredits,
                    agents: next.agents.map(agent => ({
                      agentId: agent.agentId,
                      name: agent.name,
                      concurrent: agent.concurrent ?? 1,
                      dailyRuns: agent.dailyRuns,
                      dailyCredits: agent.dailyCredits,
                    })),
                  },
                  AbortSignal.timeout(30_000),
                )
                .then(limits => {
                  fill(limits);
                  setNotice('Limits saved.');
                })
                .catch(() => setError('Couldn’t save these limits. Try again.'))
                .finally(() => setSaving(false));
            }}
          >
            Save limits
          </Button>
          {invalid && <span className="text-sm text-muted-foreground">Enter whole numbers within each range.</span>}
          {notice && (
            <span role="status" className="text-sm text-muted-foreground">
              {notice}
            </span>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </SettingsGroup>
  );
}
