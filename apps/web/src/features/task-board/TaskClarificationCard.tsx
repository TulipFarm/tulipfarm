import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { BrandIcon } from '@tulipfarm/sprout/brand-icon';
import { Button } from '@tulipfarm/sprout/button';
import { Field } from '@tulipfarm/sprout/field';
import { Input } from '@tulipfarm/sprout/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tulipfarm/sprout/select';
import { Textarea } from '@tulipfarm/sprout/textarea';
import type { TaskClarificationView } from '@tulipfarm/agents/task-clarification-contracts';
import { GitHubRepositoryPicker } from '@/features/code-sessions/GitHubRepositoryPicker';
import { apiOrigin } from '@/lib/auth';

function ClarificationField({
  id,
  label,
  required,
  helper,
  children,
}: {
  id: string;
  label: string;
  required: boolean;
  helper?: string | undefined;
  children: ReactElement;
}) {
  if (required) {
    return (
      <Field id={id} label={label} required helper={helper}>
        {children}
      </Field>
    );
  }
  return (
    <Field id={id} label={label} optional helper={helper}>
      {children}
    </Field>
  );
}

type ClarificationsResponse = {
  items: TaskClarificationView[];
};

export function TaskClarificationCard({
  workspaceId,
  tableId,
  rowId,
  onAnswered,
}: {
  workspaceId: string;
  tableId: string;
  rowId: string;
  onAnswered: () => Promise<void>;
}) {
  const [items, setItems] = useState<TaskClarificationView[]>([]);
  const [valuesById, setValuesById] = useState<Record<string, Record<string, string>>>({});
  const [submittingId, setSubmittingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch(
        `${apiOrigin}/v1/workspaces/${workspaceId}/tables/${tableId}/rows/${rowId}/clarifications`,
        { credentials: 'include' },
      );
      if (!response.ok) return;
      const data = (await response.json()) as ClarificationsResponse;
      setItems(data.items ?? []);
      setValuesById(prev => {
        const next = { ...prev };
        for (const item of data.items ?? []) {
          if (!next[item.id]) {
            const initial: Record<string, string> = {};
            const accounts = item.githubAccounts ?? [];
            for (const field of item.fields) {
              if (field.kind === 'github_account' && accounts.length === 1) {
                initial[field.id] = accounts[0]!.value;
              }
            }
            next[item.id] = initial;
          }
        }
        return next;
      });
    } catch {
      // Best-effort polling; task page continues rendering normally if clarifications fail to load.
    }
  }, [workspaceId, tableId, rowId]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, 10_000);
    return () => window.clearInterval(timer);
  }, [load]);

  if (items.length === 0) return null;

  const setField = (clarificationId: string, fieldId: string, value: string) => {
    setValuesById(prev => ({
      ...prev,
      [clarificationId]: {
        ...prev[clarificationId],
        [fieldId]: value,
      },
    }));
  };

  const submit = async (item: TaskClarificationView) => {
    const answers = valuesById[item.id] ?? {};
    for (const field of item.fields) {
      if (field.required && !answers[field.id]?.trim()) {
        setError(`Please fill in "${field.label}" before continuing.`);
        return;
      }
    }
    setSubmittingId(item.id);
    setError(null);
    try {
      const response = await fetch(
        `${apiOrigin}/v1/workspaces/${workspaceId}/tables/${tableId}/rows/${rowId}/clarifications/${item.id}/answer`,
        {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ answers }),
        },
      );
      if (response.status === 409) {
        await load();
        await onAnswered();
        return;
      }
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        setError(payload.error ?? 'Could not submit your answers. Try again.');
        return;
      }
      await load();
      await onAnswered();
    } catch {
      setError('Could not submit your answers. Check your connection and try again.');
    } finally {
      setSubmittingId(null);
    }
  };

  return (
    <div className="space-y-3" data-testid="task-clarification-cards">
      {items.map(item => {
        const values = valuesById[item.id] ?? {};
        const githubAccounts = item.githubAccounts ?? [];
        const busy = submittingId === item.id;
        return (
          <section
            key={item.id}
            className="space-y-3 rounded-lg border border-warning/40 bg-warning-subtle/40 p-4"
            aria-label={item.title}
          >
            <div className="space-y-1">
              <h4 className="text-sm font-semibold">{item.title}</h4>
              {item.summary && <p className="text-sm text-muted-foreground">{item.summary}</p>}
            </div>
            <div className="space-y-3">
              {item.fields.map(field => {
                const value = values[field.id] ?? '';
                const fieldId = `clarify-${item.id}-${field.id}`;
                if (field.kind === 'github_account') {
                  return (
                    <ClarificationField
                      key={field.id}
                      id={fieldId}
                      label={field.label}
                      required={field.required}
                      helper={
                        field.description ??
                        (githubAccounts.length === 0
                          ? 'No GitHub accounts connected yet. Connect a personal or team GitHub account in Settings → Integrations.'
                          : 'Choose a personal or team GitHub account for this task.')
                      }
                    >
                      <Select
                        value={value}
                        onValueChange={next => setField(item.id, field.id, next ?? '')}
                        disabled={busy || githubAccounts.length === 0}
                      >
                        <SelectTrigger>
                          <SelectValue>
                            <span className="inline-flex items-center gap-2">
                              <BrandIcon brand="github" size="inline" />
                              <span>
                                {githubAccounts.find(opt => opt.value === value)?.label ??
                                  (githubAccounts.length === 0
                                    ? 'No GitHub accounts connected'
                                    : 'Choose a GitHub account')}
                              </span>
                            </span>
                          </SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          {githubAccounts.map(opt => (
                            <SelectItem key={opt.value} value={opt.value}>
                              <span className="inline-flex items-center gap-2">
                                <BrandIcon brand="github" size="inline" />
                                <span>{opt.label}</span>
                              </span>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </ClarificationField>
                  );
                }
                if (field.kind === 'github_repository') {
                  return (
                    <ClarificationField
                      key={field.id}
                      id={fieldId}
                      label={field.label}
                      required={field.required}
                      helper={field.description ?? 'Choose a connected GitHub repository or type owner/repo.'}
                    >
                      <GitHubRepositoryPicker
                        id={fieldId}
                        workspaceId={workspaceId}
                        value={value}
                        onChange={nextRepo => setField(item.id, field.id, nextRepo)}
                        disabled={busy}
                        ariaLabel={field.label}
                        placeholder="Choose a repository"
                      />
                    </ClarificationField>
                  );
                }
                if (field.kind === 'select' && field.options?.length) {
                  return (
                    <ClarificationField
                      key={field.id}
                      id={fieldId}
                      label={field.label}
                      required={field.required}
                      helper={field.description}
                    >
                      <Select
                        value={value}
                        onValueChange={next => setField(item.id, field.id, next ?? '')}
                        disabled={busy}
                      >
                        <SelectTrigger>
                          <SelectValue>
                            {field.options.find(opt => opt.value === value)?.label ?? 'Select an option'}
                          </SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          {field.options.map(opt => (
                            <SelectItem key={opt.value} value={opt.value}>
                              {opt.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </ClarificationField>
                  );
                }
                return (
                  <ClarificationField
                    key={field.id}
                    id={fieldId}
                    label={field.label}
                    required={field.required}
                    helper={field.description}
                  >
                    {field.kind === 'text' && field.multiline ? (
                      <Textarea
                        rows={3}
                        value={value}
                        onChange={e => setField(item.id, field.id, e.target.value)}
                        placeholder={field.placeholder ?? 'Enter value'}
                        disabled={busy}
                      />
                    ) : (
                      <Input
                        value={value}
                        onChange={e => setField(item.id, field.id, e.target.value)}
                        placeholder={
                          ('placeholder' in field && typeof field.placeholder === 'string'
                            ? field.placeholder
                            : undefined) ?? 'Enter value'
                        }
                        disabled={busy}
                      />
                    )}
                  </ClarificationField>
                );
              })}
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <div className="flex items-center justify-end gap-2">
              <Button size="sm" disabled={busy} onClick={() => void submit(item)}>
                {busy ? 'Submitting…' : 'Submit & continue'}
              </Button>
            </div>
          </section>
        );
      })}
    </div>
  );
}
