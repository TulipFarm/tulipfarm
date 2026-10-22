import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { Briefcase } from 'reicon-react/icons/Briefcase';
import { Check } from 'reicon-react/icons/Check';
import { FileTypeIcon } from '@tulipfarm/sprout/attachment';
import { Button } from '@tulipfarm/sprout/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@tulipfarm/sprout/dialog';
import { Skeleton } from '@tulipfarm/sprout/skeleton';
import { Spinner } from '@tulipfarm/sprout/spinner';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import type { FileAudience } from '@/features/chat/conversation-api';
import { projectApi, type Project } from '@/features/projects/api';
import { useProjectChanges } from '@/features/projects/queries';
import { useFeatureRead } from '@/lib/query';
import { errorMessage, type FilesApi, type FileSummary } from './api';
import { SharingDialog, type FinalFocus } from './sharing';
import { FileStatus } from './use-in-chat';
import { PromotionSummary } from './promotion-summary';

/** Where the files go, how far the audience check has got, and then each file's add. */
type Step =
  | { kind: 'choose' }
  | { kind: 'checking'; project: Project }
  | { kind: 'failed'; project: Project; message: string }
  | { kind: 'resolve'; project: Project; readers: number; audience: ReadonlyMap<string, FileAudience> }
  | { kind: 'adding'; project: Project; results: ReadonlyMap<string, Added> };
type Added = { kind: 'waiting' } | { kind: 'adding' } | { kind: 'added' } | { kind: 'failed'; message: string };

const limit = 20;
const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

export function AddToProjectDialog({
  api,
  workspaceId,
  workspaceSlug,
  membershipId,
  items,
  finalFocus,
  onClose,
}: {
  api: FilesApi;
  workspaceId: string;
  workspaceSlug: string;
  membershipId: string;
  items: FileSummary[];
  finalFocus?: FinalFocus;
  onClose: () => void;
}) {
  const projects = useMemo(() => projectApi(workspaceId), [workspaceId]);
  const changed = useProjectChanges();
  const [files, setFiles] = useState(() => items.filter(item => item.kind === 'file'));
  const folders = items.length - files.length;
  const [step, setStep] = useState<Step>({ kind: 'choose' });
  const [granting, setGranting] = useState<{
    file: FileSummary;
    people: { membershipId: string; name: string }[];
  } | null>(null);
  const [rechecking, setRechecking] = useState(false);
  const commands = useRef(new Map<string, string>());
  const review = useRef<HTMLDivElement>(null);
  const checking = useRef<AbortController | null>(null);
  useEffect(() => () => checking.current?.abort(), []);

  async function check(project: Project, selected: FileSummary[], recheck = false) {
    checking.current?.abort();
    const controller = new AbortController();
    checking.current = controller;
    if (recheck) setRechecking(true);
    else setStep({ kind: 'checking', project });
    try {
      const result = await projects.fileAudience(
        project.id,
        selected.map(file => file.id),
        AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
      );
      if (controller.signal.aborted) return;
      setStep({
        kind: 'resolve',
        project,
        readers: result.readers,
        audience: new Map(result.files.map(file => [file.fileId, file])),
      });
    } catch (error) {
      if (controller.signal.aborted) return;
      setStep({
        kind: 'failed',
        project,
        message: errorMessage(
          error,
          'Couldn’t check who can open these files. Nothing was added. Check your connection and try again.',
        ),
      });
    } finally {
      if (checking.current === controller) setRechecking(false);
    }
  }

  async function add(project: Project, selected: FileSummary[], prior: ReadonlyMap<string, Added>) {
    let results = new Map(prior);
    const set = (fileId: string, value: Added) => {
      results = new Map(results).set(fileId, value);
      setStep({ kind: 'adding', project, results });
    };
    for (const file of selected) {
      if (results.get(file.id)?.kind === 'added') continue;
      set(file.id, { kind: 'adding' });
      const commandId = commands.current.get(file.id) ?? crypto.randomUUID();
      commands.current.set(file.id, commandId);
      try {
        await projects.addFile(project.id, { fileId: file.id, commandId });
        void changed(project.id);
        set(file.id, { kind: 'added' });
      } catch (error) {
        set(file.id, {
          kind: 'failed',
          message: errorMessage(error, 'We couldn’t confirm this file was added. Try again; it won’t be added twice.'),
        });
      }
    }
  }

  function remove(file: FileSummary) {
    const next = files.filter(entry => entry.id !== file.id);
    setFiles(next);
    if (!next.length) onClose();
  }

  const adding = step.kind === 'adding' && [...step.results.values()].some(result => result.kind === 'adding');
  const title =
    files.length === 1 ? `Add “${files[0]?.name}” to a project` : `Add ${plural(files.length, 'file')} to a project`;
  let body: ReactNode;
  let footer: ReactNode;
  if (!files.length) {
    body = (
      <StatePanel
        kind="unavailable"
        heading="h3"
        title="No files selected"
        description="Folders can’t be added to a project. Select files instead."
      />
    );
    footer = <Button onClick={onClose}>Close</Button>;
  } else if (files.length > limit) {
    body = (
      <StatePanel
        kind="unavailable"
        heading="h3"
        title={`Choose up to ${limit} files`}
        description={`You can add up to ${limit} files at a time. You selected ${files.length}.`}
      />
    );
    footer = <Button onClick={onClose}>Back to Files</Button>;
  } else if (step.kind === 'choose') {
    body = <Destinations api={projects} workspaceSlug={workspaceSlug} choose={project => void check(project, files)} />;
    footer = (
      <Button variant="outline" onClick={onClose}>
        Cancel
      </Button>
    );
  } else if (step.kind === 'checking') {
    body = (
      <div role="status" className="space-y-3 py-2">
        <p className="text-sm text-muted-foreground">
          Checking who in {step.project.name} can open {files.length === 1 ? 'it' : 'them'}…
        </p>
        <Skeleton />
        <Skeleton />
      </div>
    );
    footer = (
      <Button
        variant="outline"
        onClick={() => {
          checking.current?.abort();
          setStep({ kind: 'choose' });
        }}
      >
        Choose another project
      </Button>
    );
  } else if (step.kind === 'failed') {
    body = (
      <StatePanel kind="error" heading="h3" title="Couldn’t check access" description={step.message}>
        <Button variant="outline" onClick={() => void check(step.project, files)}>
          Check access again
        </Button>
      </StatePanel>
    );
    footer = (
      <Button variant="outline" onClick={() => setStep({ kind: 'choose' })}>
        Choose another project
      </Button>
    );
  } else if (step.kind === 'resolve') {
    const { project, readers, audience } = step;
    const blocked = files.filter(file => audience.get(file.id)?.status !== 'ready');
    body = (
      <div ref={review} role="group" tabIndex={-1} aria-label="Access review" className="space-y-3 rounded-lg">
        <p role="status" className="sr-only">
          {rechecking
            ? 'Checking access again…'
            : blocked.length
              ? `${plural(blocked.length, 'file')} need${blocked.length === 1 ? 's' : ''} attention.`
              : 'Everyone in this project can open these files.'}
        </p>
        <PromotionSummary
          destination={
            <>
              <Briefcase size={14} aria-hidden="true" />
              <span className="min-w-0 wrap-anywhere">{project.name} · Project files</span>
            </>
          }
          audience={`${plural(readers, 'person', 'people')}: everyone in ${project.name}. Project chats use the text in their answers.`}
        />
        <p className="text-sm text-muted-foreground">
          TulipFarm saves the text of each file as it is now. It won’t follow later edits. If anyone in the project
          loses access to a file, or it’s deleted, project chats stop using it.
        </p>
        <ul aria-label="Files to add" className="divide-y rounded-lg border">
          {files.map(file => (
            <li key={file.id} className="space-y-2 px-3 py-2.5">
              <p className="flex min-w-0 items-center gap-2 text-sm font-medium text-foreground">
                <FileTypeIcon name={file.name} mediaType={file.mediaType ?? ''} />
                <span className="min-w-0 truncate" title={file.name}>
                  {file.name}
                </span>
              </p>
              <FileStatus
                file={file}
                audience={audience.get(file.id)}
                place="this project"
                grant={people => setGranting({ file, people })}
                remove={() => remove(file)}
              />
            </li>
          ))}
        </ul>
      </div>
    );
    footer = (
      <>
        <Button variant="ghost" onClick={() => setStep({ kind: 'choose' })}>
          Choose another project
        </Button>
        <Button
          disabled={rechecking || blocked.length > 0}
          aria-busy={rechecking}
          onClick={() => void add(project, files, new Map())}
        >
          {rechecking
            ? 'Checking access…'
            : blocked.length
              ? `${plural(blocked.length, 'file')} need${blocked.length === 1 ? 's' : ''} attention`
              : `Add to ${project.name}`}
        </Button>
      </>
    );
  } else {
    const { project, results } = step;
    const failed = files.filter(file => results.get(file.id)?.kind === 'failed');
    const added = files.filter(file => results.get(file.id)?.kind === 'added').length;
    body = (
      <>
        <p role="status" className="text-sm text-foreground">
          {adding
            ? `Reading and saving text for ${project.name}…`
            : added === files.length
              ? `${files.length === 1 ? 'Added' : `All ${files.length} added`} to ${project.name}. Project chats can use ${files.length === 1 ? 'it' : 'them'} now.`
              : `${added} of ${files.length} added to ${project.name}.`}
        </p>
        <ul aria-label="Files added" className="divide-y rounded-lg border">
          {files.map(file => {
            const result = results.get(file.id) ?? { kind: 'waiting' };
            return (
              <li key={file.id} className="space-y-1.5 px-3 py-2.5">
                <p className="flex min-w-0 items-center gap-2 text-sm font-medium text-foreground">
                  <FileTypeIcon name={file.name} mediaType={file.mediaType ?? ''} />
                  <span className="min-w-0 truncate" title={file.name}>
                    {file.name}
                  </span>
                </p>
                {result.kind === 'waiting' && <p className="text-sm text-muted-foreground">Waiting…</p>}
                {result.kind === 'adding' && (
                  <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
                    <Spinner aria-hidden="true" />
                    Reading text…
                  </p>
                )}
                {result.kind === 'added' && (
                  <p className="flex items-center gap-1.5 text-sm text-foreground">
                    <Check size={14} aria-hidden="true" />
                    Added
                  </p>
                )}
                {result.kind === 'failed' && (
                  <p role="alert" className="text-sm text-destructive">
                    {result.message}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      </>
    );
    footer = (
      <>
        {failed.length > 0 && !adding && (
          <Button variant="outline" onClick={() => void add(project, files, results)}>
            Try {failed.length === 1 ? 'it' : `${failed.length} files`} again
          </Button>
        )}
        {added > 0 && !adding && (
          <Button
            variant="outline"
            nativeButton={false}
            render={<Link to="/$workspaceSlug/projects/$projectId" params={{ workspaceSlug, projectId: project.id }} />}
          >
            Open {project.name}
          </Button>
        )}
        <Button disabled={adding} aria-busy={adding} onClick={onClose}>
          {adding ? 'Adding…' : 'Done'}
        </Button>
      </>
    );
  }

  return (
    <>
      <Dialog
        open
        onOpenChange={open => {
          if (!open && !granting && !adding) onClose();
        }}
      >
        <DialogContent size="form" finalFocus={finalFocus}>
          <DialogHeader>
            <DialogTitle>
              <span className="wrap-anywhere">{title}</span>
            </DialogTitle>
            <DialogDescription>
              Saves the file’s text as a project file. It won’t be added to anyone’s Knowledge.
              {folders > 0 && ` ${plural(folders, 'folder')} ${folders === 1 ? 'isn’t' : 'aren’t'} included.`}
            </DialogDescription>
          </DialogHeader>
          <div className="-mx-4 min-h-0 space-y-3 overflow-y-auto px-4 pb-1">{body}</div>
          <DialogFooter>{footer}</DialogFooter>
        </DialogContent>
      </Dialog>
      {granting && step.kind === 'resolve' && (
        <SharingDialog
          api={api}
          item={granting.file}
          membershipId={membershipId}
          workspaceSlug={workspaceSlug}
          invite={{ reason: 'in this project', people: granting.people }}
          onClose={() => {
            setGranting(null);
            // The review dialog reclaims focus when the nested sharing dialog closes; move it to the review after that.
            setTimeout(() => review.current?.focus());
            void check(step.project, files, true);
          }}
        />
      )}
    </>
  );
}

function Destinations({
  api,
  workspaceSlug,
  choose,
}: {
  api: ReturnType<typeof projectApi>;
  workspaceSlug: string;
  choose: (project: Project) => void;
}) {
  const read = useFeatureRead({
    key: ['projects', 'file-destinations'],
    staleTime: 0,
    load: signal => api.list(signal),
  });
  if (read.state.kind === 'loading')
    return (
      <div role="status" aria-label="Loading projects" className="space-y-3 py-2">
        <Skeleton />
        <Skeleton />
        <Skeleton />
        <span className="sr-only">Loading projects…</span>
      </div>
    );
  if (read.state.kind === 'error' || read.state.kind === 'unavailable')
    return (
      <StatePanel
        kind="error"
        heading="h3"
        title="Couldn’t load your projects"
        description="Nothing was added. Check your connection and try again."
      >
        <Button variant="outline" onClick={() => void read.refresh()}>
          Retry loading projects
        </Button>
      </StatePanel>
    );
  const editable = read.state.data.filter(project => project.manager && !project.archived);
  if (!editable.length)
    return (
      <StatePanel
        kind="empty"
        heading="h3"
        icon={Briefcase}
        title="No projects you can add files to"
        description="Only project managers can add files. Create a project, or ask a manager of an existing project to add this file."
      >
        <Button
          variant="outline"
          nativeButton={false}
          render={<Link to="/$workspaceSlug/projects" params={{ workspaceSlug }} search={{ new: true }} />}
        >
          Create a project
        </Button>
      </StatePanel>
    );
  return (
    <section aria-labelledby="add-to-project-list" className="space-y-2">
      <h3 id="add-to-project-list" className="text-sm font-medium text-foreground">
        Projects you manage
      </h3>
      {read.state.error && (
        <p role="alert" className="text-sm text-destructive">
          Couldn’t refresh your projects. Showing the last list.
        </p>
      )}
      <ul aria-label="Projects you manage" className="space-y-0.5">
        {editable.map(project => (
          <li key={project.id}>
            <Button variant="ghost" size="nav" onClick={() => choose(project)}>
              <Briefcase size={16} aria-hidden="true" />
              <span className="min-w-0 truncate" title={project.name}>
                {project.name}
              </span>
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}
