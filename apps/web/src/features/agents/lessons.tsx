import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { Badge } from '@tulipfarm/sprout/badge';
import { Button } from '@tulipfarm/sprout/button';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@tulipfarm/sprout/dialog';
import { Field } from '@tulipfarm/sprout/field';
import { FormSection } from '@tulipfarm/sprout/form';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { Textarea } from '@tulipfarm/sprout/textarea';
import { TableRequestError } from '@/features/tables/request-state';
import {
  useAgentLessons,
  useLessonsApi,
  type AgentLesson,
  type AgentLessonsData,
  type AgentSuggestion,
  type LessonsApi,
} from './lessons-api';

const kindLabels: Record<AgentLesson['kind'], string> = {
  rejection: 'From a rejection',
  approval: 'From an approval',
  'tool-failure': 'From a tool error',
  correction: 'From a correction',
  clarification: 'From an answer',
};
const areaLabels: Record<AgentSuggestion['area'], string> = {
  instructions: 'Instructions',
  skills: 'Skills',
  tools: 'Tools',
};
const errorText = (error: unknown) =>
  error instanceof TableRequestError ? error.message : "Your change wasn't saved. Try again.";
const date = (value: string) => {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toLocaleDateString(undefined, { dateStyle: 'medium' });
};

/** What this agent learned from earlier runs, and the changes its runs suggest. Only people who can edit it see this. */
export function AgentLessons({
  workspaceId,
  workspaceSlug,
  agentId,
  enabled,
}: {
  workspaceId: string;
  workspaceSlug: string;
  agentId: string;
  enabled: boolean;
}) {
  const api = useLessonsApi(workspaceId, agentId);
  const read = useAgentLessons(api, agentId, enabled);
  if (read.state.kind === 'loading')
    return <StatePanel kind="loading" title="Loading lessons" description="Finding what this agent learned." />;
  if (read.state.kind !== 'ready')
    return (
      <StatePanel kind="error" title="Lessons could not load" description="Tasks still run. Try again in a moment.">
        <Button variant="outline" onClick={() => void read.refresh()}>
          Retry
        </Button>
      </StatePanel>
    );
  return (
    <div className="grid gap-6">
      <LessonList api={api} data={read.state.data} refresh={() => void read.refresh()} />
      <Suggestions
        api={api}
        data={read.state.data}
        agentId={agentId}
        workspaceSlug={workspaceSlug}
        refresh={() => void read.refresh()}
      />
    </div>
  );
}

function LessonList({ api, data, refresh }: { api: LessonsApi; data: AgentLessonsData; refresh: () => void }) {
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);
  async function act(id: string, operation: () => Promise<unknown>) {
    setBusy(id);
    setError(null);
    try {
      await operation();
      refresh();
      return true;
    } catch (failure) {
      setError(errorText(failure));
      return false;
    } finally {
      setBusy(null);
    }
  }
  return (
    <FormSection
      title="Lessons"
      label="Lessons"
      meta={`${data.lessons.length} / ${data.limits.lessons}`}
      description="What this agent learned from earlier tasks, such as why a change was rejected. It uses these lessons in every new task, for everyone who runs it."
    >
      {!data.lessons.length ? (
        <p className="text-sm text-muted-foreground">
          No lessons yet. After a task, the agent learns from your approvals, rejections and replies.
        </p>
      ) : (
        <ul aria-label="Lessons" className="divide-y divide-border rounded-xl border border-border bg-card">
          {data.lessons.map(lesson => (
            <li key={lesson.id} className="grid gap-2 px-4 py-3">
              {editing?.id === lesson.id ? (
                <form
                  className="grid gap-2"
                  onSubmit={async event => {
                    event.preventDefault();
                    if (await act(lesson.id, () => api.edit(lesson.id, editing.text))) setEditing(null);
                  }}
                >
                  <Field
                    label="Lesson"
                    required
                    counter={`${editing.text.length} / ${data.limits.lessonCharacters}`}
                    helper="One general sentence. No names, links, numbers or quotes."
                  >
                    <Textarea
                      rows={2}
                      maxLength={data.limits.lessonCharacters}
                      value={editing.text}
                      onChange={event => setEditing({ id: lesson.id, text: event.target.value })}
                    />
                  </Field>
                  <div className="flex gap-2">
                    <Button
                      type="submit"
                      size="sm"
                      state={
                        busy === lesson.id
                          ? { kind: 'busy' }
                          : editing.text.trim()
                            ? { kind: 'ready' }
                            : { kind: 'blocked', reason: 'Write the lesson first.' }
                      }
                    >
                      Save
                    </Button>
                    <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(null)}>
                      Cancel
                    </Button>
                  </div>
                </form>
              ) : (
                <div className="flex flex-wrap items-start gap-3">
                  <div className="grid min-w-0 flex-1 gap-1 text-sm">
                    <span className="text-foreground">{lesson.text}</span>
                    <span className="flex flex-wrap items-center gap-2 text-muted-foreground">
                      <Badge variant="outline">{kindLabels[lesson.kind]}</Badge>
                      {date(lesson.confirmedAt) && <span>Last confirmed {date(lesson.confirmedAt)}</span>}
                    </span>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setError(null);
                        setEditing({ id: lesson.id, text: lesson.text });
                      }}
                    >
                      Edit
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Delete lesson: ${lesson.text}`}
                      state={busy === lesson.id ? { kind: 'busy' } : { kind: 'ready' }}
                      onClick={() => void act(lesson.id, () => api.remove(lesson.id))}
                    >
                      Delete
                    </Button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {data.lessons.length > 0 && (
        <div>
          <Button variant="outline" onClick={() => setClearing(true)}>
            Delete all lessons
          </Button>
        </div>
      )}
      {error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <Dialog open={clearing} onOpenChange={setClearing}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete all lessons?</DialogTitle>
            <DialogDescription>
              This agent forgets all its lessons for everyone who runs it. You can't undo this.
            </DialogDescription>
          </DialogHeader>
          <DialogBody />
          <DialogFooter>
            <Button variant="outline" onClick={() => setClearing(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              state={busy === 'all' ? { kind: 'busy' } : { kind: 'ready' }}
              onClick={async () => {
                if (await act('all', api.clear)) setClearing(false);
              }}
            >
              Delete all lessons
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </FormSection>
  );
}

function Suggestions({
  api,
  data,
  agentId,
  workspaceSlug,
  refresh,
}: {
  api: LessonsApi;
  data: AgentLessonsData;
  agentId: string;
  workspaceSlug: string;
  refresh: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!data.suggestions.length) return null;
  return (
    <FormSection
      title="Suggested changes"
      label="Suggested changes"
      description="Changes to this agent's instructions, Skills or tools, suggested by its earlier tasks. Nothing changes until you review a draft in chat and approve it."
    >
      <ul aria-label="Suggested changes" className="divide-y divide-border rounded-xl border border-border bg-card">
        {data.suggestions.map(suggestion => (
          <li key={suggestion.id} className="flex flex-wrap items-start gap-3 px-4 py-3">
            <div className="grid min-w-0 flex-1 gap-1 text-sm">
              <span className="text-foreground">{suggestion.text}</span>
              <span>
                <Badge variant="outline">{areaLabels[suggestion.area]}</Badge>
              </span>
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                nativeButton={false}
                render={
                  <Link
                    to="/$workspaceSlug"
                    params={{ workspaceSlug }}
                    search={{ intent: 'improve-agent', agentId, suggestion: suggestion.text }}
                  />
                }
              >
                Review in chat
              </Button>
              <Button
                variant="ghost"
                size="sm"
                aria-label={`Dismiss suggestion: ${suggestion.text}`}
                state={busy === suggestion.id ? { kind: 'busy' } : { kind: 'ready' }}
                onClick={async () => {
                  setBusy(suggestion.id);
                  setError(null);
                  try {
                    await api.dismiss(suggestion.id);
                    refresh();
                  } catch (failure) {
                    setError(errorText(failure));
                  } finally {
                    setBusy(null);
                  }
                }}
              >
                Dismiss
              </Button>
            </div>
          </li>
        ))}
      </ul>
      {error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </FormSection>
  );
}
