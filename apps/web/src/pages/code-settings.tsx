import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { workspaceRoute } from '@/router';
import { PageContent } from '@tulipfarm/sprout/page-content';
import { PageHeader } from '@tulipfarm/sprout/page-header';
import { SettingsGroup, SettingsRow } from '@tulipfarm/sprout/settings-list';
import { Button } from '@tulipfarm/sprout/button';
import { Input } from '@tulipfarm/sprout/input';
import { Switch } from '@tulipfarm/sprout/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tulipfarm/sprout/select';
import {
  CODE_SESSION_COMMIT_TRAILER,
  defaultMemberCodeSettings,
  type MemberCodeSettings,
} from '@tulipfarm/agents/code-session-contracts';
import type { CodingAgent } from '@tulipfarm/agents/coding-run-contracts';
import { codeSessionApi } from '@/features/code-sessions/api';

type SaveState = { kind: 'idle' } | { kind: 'saving' } | { kind: 'saved' } | { kind: 'error'; message: string };

export function CodeSettingsPage() {
  const { workspace } = workspaceRoute.useRouteContext();
  const api = useMemo(() => codeSessionApi(workspace.id), [workspace.id]);
  const [settings, setSettings] = useState<MemberCodeSettings>(defaultMemberCodeSettings);
  const [loading, setLoading] = useState(true);
  const [save, setSave] = useState<SaveState>({ kind: 'idle' });

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    void api
      .getSettings(controller.signal)
      .then(loaded => {
        setSettings(loaded);
        setLoading(false);
      })
      .catch(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [api]);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setSave({ kind: 'saving' });
    try {
      const saved = await api.updateSettings(settings);
      setSettings(saved);
      setSave({ kind: 'saved' });
    } catch (error) {
      setSave({ kind: 'error', message: error instanceof Error ? error.message : 'Could not save code settings.' });
    }
  }

  const defaultReviewerAgent: CodingAgent = settings.reviewers[0]?.agent ?? 'claude-code';

  return (
    <PageContent>
      <PageHeader
        titleId="code-settings-heading"
        focusable
        title="Code"
        description="Defaults for your coding agent sessions, pull requests, and code reviewers."
      />
      <form onSubmit={onSubmit} className="space-y-6">
        <SettingsGroup title="Branches & pull requests" titleId="code-branches-heading">
          <SettingsRow
            label="Branch prefix"
            description="Every code session pushes to <prefix>/<slug> after you approve its plan."
          >
            <div className="w-56">
              <Input
                aria-label="Branch prefix"
                value={settings.branchPrefix}
                disabled={loading || save.kind === 'saving'}
                onChange={event => setSettings(current => ({ ...current, branchPrefix: event.target.value }))}
              />
            </div>
          </SettingsRow>
          <SettingsRow
            label="Open pull requests automatically"
            description="When off, TulipFarm asks in your Inbox before opening a pull request."
          >
            <Switch
              aria-label="Open pull requests automatically"
              checked={settings.openPullRequests}
              disabled={loading || save.kind === 'saving'}
              onCheckedChange={checked => setSettings(current => ({ ...current, openPullRequests: Boolean(checked) }))}
            />
          </SettingsRow>
          <SettingsRow
            label="Open pull requests as draft"
            description="Create new pull requests in draft mode until you mark them ready."
          >
            <Switch
              aria-label="Open pull requests as draft"
              checked={settings.openAsDraft}
              disabled={loading || save.kind === 'saving'}
              onCheckedChange={checked => setSettings(current => ({ ...current, openAsDraft: Boolean(checked) }))}
            />
          </SettingsRow>
          <SettingsRow
            label="Commit co-author trailer"
            description="Added to every commit created by a coding agent during a code session."
          >
            <code className="rounded bg-muted px-2 py-1 font-mono text-xs">{CODE_SESSION_COMMIT_TRAILER}</code>
          </SettingsRow>
        </SettingsGroup>

        <SettingsGroup title="Code review" titleId="code-review-heading">
          <SettingsRow
            label="Default reviewer"
            description="Coding agent that reviews pull requests opened by your code sessions."
          >
            <div className="w-48">
              <Select
                value={defaultReviewerAgent}
                disabled={loading || save.kind === 'saving'}
                onValueChange={next => {
                  if (next === 'claude-code' || next === 'codex' || next === 'copilot') {
                    setSettings(current => ({ ...current, reviewers: [{ agent: next }] }));
                  }
                }}
              >
                <SelectTrigger aria-label="Default reviewer">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="claude-code">Claude Code</SelectItem>
                  <SelectItem value="codex">Codex</SelectItem>
                  <SelectItem value="copilot">Copilot CLI</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </SettingsRow>
        </SettingsGroup>

        <div className="flex items-center gap-3">
          <Button type="submit" disabled={loading || save.kind === 'saving'}>
            {save.kind === 'saving' ? 'Saving…' : 'Save settings'}
          </Button>
          {save.kind === 'saved' && <span className="text-sm text-muted-foreground">Saved.</span>}
          {save.kind === 'error' && <span className="text-sm text-destructive">{save.message}</span>}
        </div>
      </form>
    </PageContent>
  );
}
