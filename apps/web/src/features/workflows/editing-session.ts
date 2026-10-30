import { useCallback, useEffect, useRef, useState } from 'react';
import type { z } from 'zod';
import { authoredDefinitionSchema, type Definition, type workflowSchema } from '@tulipfarm/workflows/contracts';
import { workflowLinkKey, type WorkflowLink } from './page-search';
import { definitionProblems } from './definition-issues';

type Workflow = z.infer<typeof workflowSchema>;
type View = 'list' | 'definition' | 'runs' | 'settings';
const initial: Definition = {
  version: 1,
  name: 'Review a request',
  trigger: { kind: 'manual' },
  steps: [
    { id: 'request', kind: 'transform', fields: { request: { kind: 'input', path: [] } } },
    { id: 'review', kind: 'human', prompt: 'Review this request and provide your decision.', timeoutSeconds: 86400 },
    { id: 'result', kind: 'transform', fields: { decision: { kind: 'step', step: 'review', path: [] } } },
  ],
};

export function useWorkflowEditingSession({
  initialProvider,
  link,
  onLink,
  workflows,
  archivedWorkflows,
  archivedOpened,
  archivedState,
  onOpen,
  onRun,
  onArchivedLink,
  onArchiveLookup,
  onMessage,
}: {
  initialProvider: boolean;
  link: WorkflowLink;
  onLink: (link: WorkflowLink) => void;
  workflows: Workflow[] | null;
  archivedWorkflows: Workflow[] | null;
  archivedOpened: boolean;
  archivedState: 'loading' | 'ready' | 'error' | 'unavailable';
  onOpen: () => void;
  onRun: (runId: string) => void;
  onArchivedLink: () => void;
  onArchiveLookup: () => void;
  onMessage: (message: string) => void;
}) {
  const [selected, setSelected] = useState<Workflow | null>(null);
  const [draftId, setDraftId] = useState<string>(() => crypto.randomUUID());
  const [draftBaseRevision, setDraftBaseRevision] = useState<string | null>(null);
  const [draft, setDraft] = useState<Definition>(initial);
  const [baseline, setBaseline] = useState<Definition>(initial);
  const [advanced, setAdvanced] = useState<string | null>(null);
  const [switchTo, setSwitchTo] = useState<{ workflow: Workflow | null } | null>(null);
  const [view, setView] = useState<View>(initialProvider ? 'definition' : 'list');
  const [linkedRun, setLinkedRun] = useState<string | null>(null);
  const [restoring, setRestoring] = useState<WorkflowLink | null>(() => (link.workflow ? link : null));
  const shownLink = useRef(workflowLinkKey(link));
  const linkKey = workflowLinkKey(link);
  const dirty =
    JSON.stringify(draft) !== JSON.stringify(baseline) ||
    (advanced !== null && advanced !== JSON.stringify(draft, null, 2));

  const resetDraft = useCallback((workflow: Workflow | null) => {
    setSelected(workflow);
    setDraftId(workflow?.id ?? crypto.randomUUID());
    setDraftBaseRevision(workflow?.revision ?? null);
    setDraft(workflow?.definition ?? initial);
    setBaseline(workflow?.definition ?? initial);
    setAdvanced(null);
  }, []);
  const clear = useCallback(() => resetDraft(null), [resetDraft]);
  function open(workflow: Workflow | null) {
    setView(workflow?.archivedAt ? 'runs' : 'definition');
    resetDraft(workflow);
    setSwitchTo(null);
    setLinkedRun(null);
    onOpen();
  }
  function choose(workflow: Workflow | null) {
    if (dirty) setSwitchTo({ workflow });
    else open(workflow);
  }
  function openRun(runId: string) {
    setView('runs');
    setLinkedRun(runId);
    onRun(runId);
  }

  // Observing a newer saved revision never rebases a local draft.
  useEffect(() => {
    setSelected(previous => {
      if (!previous) return null;
      const source = previous.archivedAt ? archivedWorkflows : workflows;
      return source ? (source.find(item => item.id === previous.id) ?? null) : previous;
    });
  }, [workflows, archivedWorkflows]);
  useEffect(() => {
    if (!restoring || !workflows) return;
    const found =
      workflows.find(item => item.id === restoring.workflow) ??
      archivedWorkflows?.find(item => item.id === restoring.workflow);
    if (found) {
      if (dirty && found.id !== selected?.id) {
        setRestoring(null);
        choose(found);
        return;
      }
      if (found.archivedAt) onArchivedLink();
      open(found);
      if (restoring.view && !(found.archivedAt && restoring.view === 'settings')) setView(restoring.view);
      if (restoring.run) openRun(restoring.run);
      setRestoring(null);
    } else if (!archivedOpened) onArchiveLookup();
    else if (archivedState === 'ready' || archivedState === 'error') {
      onMessage(
        archivedState === 'error'
          ? 'The linked workflow could not be checked because archived workflows did not load. Retry from Archived.'
          : 'The linked workflow is not available to you. It isn’t shared with you, or it belongs to another workspace.',
      );
      setRestoring(null);
    }
  }, [restoring, workflows, archivedWorkflows, archivedOpened, archivedState]);
  useEffect(() => {
    if (linkKey === shownLink.current) return;
    shownLink.current = linkKey;
    if (!link.workflow) setView('list');
    else if (link.workflow !== selected?.id) setRestoring(link);
    else if (link.run) openRun(link.run);
    else setView(selected.archivedAt ? 'runs' : (link.view ?? 'definition'));
  }, [linkKey]);
  useEffect(() => {
    if (restoring) return;
    const next: WorkflowLink =
      selected && view !== 'list'
        ? {
            workflow: selected.id,
            ...(view === 'runs'
              ? { view: 'runs', ...(linkedRun ? { run: linkedRun } : {}) }
              : view === 'settings'
                ? { view: 'settings' }
                : {}),
          }
        : {};
    const key = workflowLinkKey(next);
    if (key === shownLink.current) return;
    shownLink.current = key;
    onLink(next);
  }, [restoring, selected?.id, view, linkedRun, onLink]);

  function toggleAdvanced(): string | null {
    if (advanced === null) {
      setAdvanced(JSON.stringify(draft, null, 2));
      return null;
    }
    try {
      setDraft(authoredDefinitionSchema.parse(JSON.parse(advanced)));
      setAdvanced(null);
      return '';
    } catch (failure) {
      return `This definition cannot return to the form yet. ${definitionProblems(failure).join(' ')} Your JSON edits are retained.`;
    }
  }
  return {
    selected,
    draftId,
    draftBaseRevision,
    draft,
    advanced,
    dirty,
    view,
    switching: switchTo !== null,
    editDraft: setDraft,
    editJSON: (text: string) => setAdvanced(text),
    toggleAdvanced,
    choose,
    cancelSwitch: () => setSwitchTo(null),
    confirmSwitch: () => {
      if (switchTo) open(switchTo.workflow);
    },
    showView: setView,
    openRun,
    saved: (workflow: Workflow) => {
      setSelected(workflow);
      setDraft(workflow.definition);
      setBaseline(workflow.definition);
      setDraftBaseRevision(workflow.revision);
      setAdvanced(null);
    },
    observed: (workflow: Workflow) => setSelected(workflow),
    clear,
    archived: () => {
      clear();
      setView('list');
    },
  };
}
