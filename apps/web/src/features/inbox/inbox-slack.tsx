import { useEffect, useMemo, useState } from 'react';
import { z } from 'zod';
import { SettingsGroup, SettingsRow } from '@tulipfarm/sprout/settings-list';
import { Switch } from '@tulipfarm/sprout/switch';
import { apiOrigin } from '@/lib/auth';
import { jsonResponse, readJson } from '@/lib/http';

const kinds = [
  { kind: 'assigned', label: 'Assigned to you', description: 'Someone assigns you a task.' },
  { kind: 'waiting', label: 'Waiting for you', description: 'An agent needs your answer or approval.' },
  { kind: 'finished', label: 'Agent finished', description: 'An agent finishes a task you’re following.' },
  { kind: 'mention', label: 'Mentioned you', description: 'Someone mentions you in a task.' },
] as const;
type Kind = (typeof kinds)[number]['kind'];
const preferencesSchema = z.object({
  connected: z.boolean(),
  kinds: z.object({ assigned: z.boolean(), waiting: z.boolean(), finished: z.boolean(), mention: z.boolean() }),
});
type Preferences = z.infer<typeof preferencesSchema>;

function preferencesApi(workspaceId: string) {
  const url = `${apiOrigin}/v1/workspaces/${encodeURIComponent(workspaceId)}/inbox/slack`;
  return async (signal: AbortSignal, body?: { kinds: Preferences['kinds'] }) => {
    const response = await jsonResponse(url, {
      method: body ? 'PUT' : 'GET',
      signal,
      cache: 'no-store',
      ...(body ? { body } : {}),
    });
    if (!response.ok) throw new Error('inbox-slack-failed');
    return preferencesSchema.parse(await readJson(response));
  };
}

/** The member's choice of which Inbox items also arrive as Slack direct messages. */
export function InboxSlackSettings({ workspaceId }: { workspaceId: string }) {
  const request = useMemo(() => preferencesApi(workspaceId), [workspaceId]);
  const [preferences, setPreferences] = useState<Preferences | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    request(controller.signal)
      .then(setPreferences)
      .catch(() => {
        if (!controller.signal.aborted) setError('Couldn’t load your Slack messages. Refresh to try again.');
      });
    return () => controller.abort();
  }, [request]);
  if (!preferences && !error) return null;
  const save = (kind: Kind, on: boolean) => {
    if (!preferences) return;
    const next = { ...preferences.kinds, [kind]: on };
    setPreferences({ ...preferences, kinds: next });
    setSaving(true);
    setError(null);
    request(AbortSignal.timeout(30_000), { kinds: next })
      .then(setPreferences)
      .catch(() => {
        setPreferences(preferences);
        setError('Couldn’t save that change. Try again.');
      })
      .finally(() => setSaving(false));
  };
  return (
    <SettingsGroup title="Inbox in Slack" titleId="inbox-slack-heading">
      {preferences && !preferences.connected && (
        <div className="px-4 py-3">
          <p className="text-sm text-muted-foreground">
            Slack isn’t linked yet. Message the TulipFarm app in Slack and follow its link to receive Inbox
            notifications as direct messages.
          </p>
        </div>
      )}
      {preferences?.connected &&
        kinds.map(({ kind, label, description }) => (
          <SettingsRow key={kind} label={label} description={description}>
            <Switch
              size="sm"
              aria-label={`Send “${label}” to Slack`}
              checked={preferences.kinds[kind]}
              disabled={saving}
              onCheckedChange={checked => save(kind, checked === true)}
            />
          </SettingsRow>
        ))}
      {error && (
        <p role="alert" className="px-4 py-3 text-sm text-destructive">
          {error}
        </p>
      )}
    </SettingsGroup>
  );
}
