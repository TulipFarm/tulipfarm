import { useEffect, useState } from 'react';
import { Button } from '@tulipfarm/sprout/button';
import { Textarea } from '@tulipfarm/sprout/textarea';
import { Label } from '@tulipfarm/sprout/label';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@tulipfarm/sprout/select';
import { SettingsGroup, SettingsRow } from '@tulipfarm/sprout/settings-list';
import { actionReviewApi, type ReviewSettings, type ReviewPreview } from './action-review-api';
import './action-review.css';

const permissionModes = [
  { value: 'auto', label: 'Auto', description: 'Bud saves eligible changes without asking.' },
  { value: 'ask', label: 'Ask for permissions', description: 'Bud asks before changes that match your prompt.' },
];

export function ActionReviewSettings({ workspaceId, admin }: { workspaceId: string; admin: boolean }) {
  const [saved, setSaved] = useState<ReviewSettings | null>(null);
  const [mode, setMode] = useState<'auto' | 'ask'>('auto');
  const [rule, setRule] = useState('');
  const [preview, setPreview] = useState<ReviewPreview | null>(null);
  const [notice, setNotice] = useState('');
  const [needsReload, setNeedsReload] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  function fill(value: ReviewSettings) {
    setSaved(value);
    setMode(value.mode === 'ask' ? 'ask' : 'auto');
    setRule(value.rule ?? '');
    setPreview(null);
  }
  useEffect(() => {
    const controller = new AbortController();
    setSaved(null);
    setNotice('');
    setNeedsReload(false);
    void actionReviewApi(workspaceId)
      .read(controller.signal)
      .then(value => {
        if (!controller.signal.aborted) fill(value);
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setNotice('Couldn’t load review settings.');
          setNeedsReload(true);
        }
      });
    return () => controller.abort();
  }, [workspaceId, reload]);
  async function submit() {
    if (!admin || busy || !saved) return;
    setBusy(true);
    setNotice('');
    setNeedsReload(false);
    const api = actionReviewApi(workspaceId);
    try {
      if (mode === 'ask' && !preview) {
        const result = await api.preview(rule);
        if (result.ok) setPreview(result);
        else setNotice(result.message);
      } else {
        const value = await api.save(saved, mode, rule, preview);
        fill(value);
        setNotice('Workspace review settings saved.');
      }
    } catch {
      if (mode === 'ask' && !preview) {
        setNotice('Couldn’t check your prompt. Nothing was saved. Try again.');
      } else {
        setNotice('Couldn’t confirm this change. Reload the saved settings before trying again.');
        setNeedsReload(true);
      }
    } finally {
      setBusy(false);
    }
  }
  const active =
    saved?.mode === 'legacy' ? 'No choice saved yet' : saved?.mode === 'ask' ? 'Ask for permissions' : 'Auto';
  return (
    <SettingsGroup title="Review in private Bud chats" titleId="action-review-heading">
      {saved ? (
        <>
          <SettingsRow
            label="Permission mode"
            description={
              saved.mode === 'legacy'
                ? 'Auto is preselected but isn’t active. This workspace keeps its current behavior until an admin saves a choice.'
                : 'Choose when Bud asks before making changes.'
            }
          >
            {admin && saved.canManage ? (
              <Select
                value={mode}
                disabled={busy}
                items={permissionModes}
                onValueChange={value => {
                  if (value !== 'auto' && value !== 'ask') return;
                  setMode(value);
                  setPreview(null);
                  setNotice('');
                }}
              >
                <SelectTrigger aria-label="Permission mode">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent align="end" alignItemWithTrigger={false} data-permission-menu="">
                  <SelectGroup>
                    <SelectLabel>Permissions · This workspace</SelectLabel>
                    {permissionModes.map(({ value, label, description }) => (
                      <SelectItem key={value} value={value} label={label}>
                        <span className="grid gap-0.5 py-1">
                          <span className="font-medium">{label}</span>
                          <span className="text-sm text-muted-foreground">{description}</span>
                        </span>
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            ) : (
              <span>{active}</span>
            )}
          </SettingsRow>
          {admin && saved.canManage && (
            <>
              {(mode === 'ask' || saved.mode !== 'auto') && (
                <div className="space-y-3 p-4">
                  {mode === 'ask' && (
                    <>
                      <Label htmlFor="bud-review-rule">Permission prompt</Label>
                      <Textarea
                        id="bud-review-rule"
                        value={rule}
                        disabled={busy}
                        placeholder="Ask before creating tables, but not before adding rows."
                        onChange={event => {
                          setRule(event.target.value);
                          setPreview(null);
                          setNotice('');
                        }}
                      />
                      {preview && (
                        <p aria-live="polite">
                          <strong>What your rule means: </strong>
                          {preview.interpretation}
                        </p>
                      )}
                    </>
                  )}
                  <Button disabled={busy || (mode === 'ask' && !rule.trim())} onClick={() => void submit()}>
                    {busy ? 'Working…' : mode === 'ask' && !preview ? 'Check rule' : 'Confirm and save'}
                  </Button>
                </div>
              )}
            </>
          )}
          {!(admin && saved.canManage) && saved.mode === 'ask' && <p className="p-4 text-sm">{saved.interpretation}</p>}
        </>
      ) : (
        !notice && <p role="status">Loading review settings…</p>
      )}
      {notice && (
        <div className="space-y-2 p-4">
          <p role="status">{notice}</p>
          {needsReload && (
            <Button variant="outline" disabled={busy} onClick={() => setReload(previous => previous + 1)}>
              Reload saved settings
            </Button>
          )}
        </div>
      )}
    </SettingsGroup>
  );
}
