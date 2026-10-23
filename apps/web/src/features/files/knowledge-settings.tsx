import { useEffect, useMemo, useRef, useState } from 'react';
import { z } from 'zod';
import { Switch } from '@tulipfarm/sprout/switch';
import { SettingsGroup, SettingsRow } from '@tulipfarm/sprout/settings-list';
import { apiOrigin } from '@/lib/auth';
import { jsonResponse, readJson } from '@/lib/http';

const settingsSchema = z.object({ mediaRecognition: z.boolean(), canManage: z.boolean() });
type KnowledgeSettings = z.infer<typeof settingsSchema>;

export function knowledgeSettingsApi(workspaceId: string) {
  const url = `${apiOrigin}/v1/workspaces/${encodeURIComponent(workspaceId)}/knowledge/settings`;
  async function request(signal: AbortSignal, body?: { mediaRecognition: boolean }) {
    const response = await jsonResponse(url, {
      method: body ? 'PUT' : 'GET',
      signal,
      cache: 'no-store',
      ...(body ? { body } : {}),
    });
    if (!response.ok) throw new Error('knowledge-settings-failed');
    return settingsSchema.parse(await readJson(response));
  }
  return {
    read: (signal: AbortSignal) => request(signal),
    setMediaRecognition: (mediaRecognition: boolean, signal: AbortSignal) => request(signal, { mediaRecognition }),
  };
}

/** Admin switch for reading text and charts in images inside documents added to Knowledge. */
export function KnowledgeSettings({ workspaceId }: { workspaceId: string }) {
  const api = useMemo(() => knowledgeSettingsApi(workspaceId), [workspaceId]);
  const [settings, setSettings] = useState<KnowledgeSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    api
      .read(controller.signal)
      .then(setSettings)
      .catch(() => {
        if (!controller.signal.aborted) setError('Couldn’t load Knowledge settings. Refresh to try again.');
      });
    return () => {
      controller.abort();
      active.current?.abort();
    };
  }, [api]);
  if (!settings && !error) return null;
  return (
    <SettingsGroup title="Knowledge" titleId="knowledge-heading">
      <SettingsRow
        label="Read images in documents"
        description="Read text, charts and diagrams in images inside PDFs, slides and other documents. Uses credits."
      >
        {settings && (
          <Switch
            aria-label="Read images in documents"
            checked={settings.mediaRecognition}
            disabled={!settings.canManage || saving}
            aria-busy={saving}
            onCheckedChange={enabled => {
              active.current?.abort();
              const controller = new AbortController();
              active.current = controller;
              setSaving(true);
              setError(null);
              api
                .setMediaRecognition(enabled, controller.signal)
                .then(setSettings)
                .catch(() => {
                  if (!controller.signal.aborted) setError('Couldn’t save this setting. Try again.');
                })
                .finally(() => {
                  if (active.current === controller) setSaving(false);
                });
            }}
          />
        )}
      </SettingsRow>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </SettingsGroup>
  );
}
