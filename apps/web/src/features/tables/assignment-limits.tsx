import { useEffect, useMemo, useState } from 'react';
import { z } from 'zod';
import { Button } from '@tulipfarm/sprout/button';
import { Input } from '@tulipfarm/sprout/input';
import { SettingsGroup, SettingsRow } from '@tulipfarm/sprout/settings-list';
import { apiOrigin } from '@/lib/auth';
import { jsonResponse, readJson } from '@/lib/http';

const limitsSchema = z.object({
  workspace: z.number().int().min(1).max(100),
  agents: z.array(
    z.object({
      agentId: z.uuid(),
      name: z.string(),
      concurrent: z.number().int().min(1).max(20),
      dailyRuns: z.number().int().min(1).max(10000).nullable(),
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
        agents: limits.agents.map(({ agentId, concurrent, dailyRuns }) => ({ agentId, concurrent, dailyRuns })),
      }),
  };
}

const whole = (text: string, min: number, max: number) => {
  const value = Number(text);
  return Number.isInteger(value) && value >= min && value <= max ? value : null;
};

/** Admin caps on how many assigned rows agents work on at once, and how many runs each agent starts a day. */
export function AssignmentLimitsSettings({ workspaceId }: { workspaceId: string }) {
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
      ...Object.fromEntries(
        limits.agents.flatMap(agent => [
          [`${agent.agentId}:concurrent`, String(agent.concurrent)],
          [`${agent.agentId}:daily`, agent.dailyRuns === null ? '' : String(agent.dailyRuns)],
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
  const next = saved && {
    workspace: whole(draft.workspace ?? '', 1, 100),
    agents: saved.agents.map(agent => {
      const daily = draft[`${agent.agentId}:daily`]?.trim() ?? '';
      return {
        ...agent,
        concurrent: whole(draft[`${agent.agentId}:concurrent`] ?? '', 1, 20),
        dailyRuns: daily ? whole(daily, 1, 10000) : null,
        dailyInvalid: daily !== '' && whole(daily, 1, 10000) === null,
      };
    }),
  };
  const invalid =
    !next || next.workspace === null || next.agents.some(agent => agent.concurrent === null || agent.dailyInvalid);
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
      <SettingsRow
        label="Agents working at once"
        description="The most assigned rows all agents in this workspace work on at the same time. 1 to 100."
      >
        {saved && field('workspace', 'Agents working at once')}
      </SettingsRow>
      {saved?.agents.map(agent => (
        <SettingsRow
          key={agent.agentId}
          label={agent.name}
          description="Rows this agent works on at once (1 to 20), and its runs a day. Leave runs a day empty for no daily cap."
        >
          <div className="flex gap-2">
            {field(`${agent.agentId}:concurrent`, `${agent.name}, rows at once`)}
            {field(`${agent.agentId}:daily`, `${agent.name}, runs a day`, 'No cap')}
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
                    agents: next.agents.map(agent => ({
                      agentId: agent.agentId,
                      name: agent.name,
                      concurrent: agent.concurrent ?? 1,
                      dailyRuns: agent.dailyRuns,
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
