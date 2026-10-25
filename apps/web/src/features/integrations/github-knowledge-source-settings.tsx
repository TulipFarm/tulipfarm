import { useId, useState } from 'react';
import { Button } from '@tulipfarm/sprout/button';
import { Form, FormFooter } from '@tulipfarm/sprout/form';
import { SearchField } from '@tulipfarm/sprout/search-field';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import {
  githubConcealKeys,
  type GitHubKnowledgeApi,
  type GitHubSettings,
  type GitHubSource,
} from './github-knowledge-api';
import { checkGitHubContent, GitHubContentOptions, githubContentValue } from './github-knowledge-content';
import { filterGitHubRepositories } from './github-repositories';
import { CommandFeedback, useCommand } from './slack-knowledge-shared';
import { GitHubRepositoryChoices } from './github-repository-choices';

/**
 * Opt-out settings for one source: every repository and content kind is indexed unless a member leaves it out here.
 */
export function GitHubSourceSettings({
  api,
  source,
  onSaved,
  onClose,
}: {
  api: GitHubKnowledgeApi;
  source: GitHubSource & { selection: NonNullable<GitHubSource['selection']> };
  onSaved: () => Promise<void>;
  onClose: () => void;
}) {
  const formId = useId();
  const repositories = source.repositories ?? [];
  const [content, setContent] = useState(() => githubContentValue(source.selection));
  const [excluded, setExcluded] = useState(
    () => new Set(repositories.filter(item => item.excluded).map(item => item.repositoryId)),
  );
  const [search, setSearch] = useState('');
  const [limit, setLimit] = useState(50);
  const [attempted, setAttempted] = useState(false);
  const command = useCommand<GitHubSettings, GitHubSource>(
    (input, signal) => api.settings(source.sourceId, input, signal),
    onSaved,
    githubConcealKeys,
  );
  const checked = checkGitHubContent(content);
  const filtered = filterGitHubRepositories(repositories, search, '');
  const visible = filtered.slice(0, limit);
  const included = repositories.length - excluded.size;
  const all = source.selection.scope === 'all';
  const initial = githubContentValue(source.selection);
  const dirty =
    JSON.stringify(content) !== JSON.stringify(initial) ||
    repositories.some(item => item.excluded !== excluded.has(item.repositoryId));
  return (
    <section aria-label="GitHub source settings" className="space-y-4 rounded-lg bg-muted p-4">
      <Form
        id={formId}
        label="GitHub source settings"
        disabled={command.locked}
        onSubmit={() => {
          if (command.locked) return;
          setAttempted(true);
          if (!checked.valid || !included) return 'invalid';
          void command.send({
            commandId: crypto.randomUUID(),
            kinds: checked.kinds,
            excludePaths: checked.excludePaths,
            after: checked.after,
            excludedRepositories: [...excluded].sort(),
          });
        }}
      >
        <fieldset disabled={command.locked} className="min-w-0 space-y-5">
          <section aria-label="Repositories to index" className="space-y-3">
            <h5 className="text-sm font-medium">Repositories</h5>
            <p className="text-sm text-muted-foreground">
              {all
                ? 'Every repository this GitHub account can read is indexed, and new repositories are added automatically. Clear a repository to leave it out; it stays out until you select it again. A repository one of your chosen-repository sources indexes is indexed there instead, and comes back here when that source no longer indexes it.'
                : 'Every repository in this source is indexed. Clear a repository to leave it out.'}
            </p>
            {!repositories.length ? (
              <StatePanel
                kind="empty"
                heading="h3"
                title="No repositories found yet"
                description="The first sync lists every repository this account can read. Check again after it finishes."
              />
            ) : (
              <>
                <SearchField
                  label="Find repositories"
                  value={search}
                  onChange={value => {
                    setSearch(value);
                    setLimit(50);
                  }}
                />
                <p role="status" className="text-xs text-muted-foreground">
                  {included} of {repositories.length} {repositories.length === 1 ? 'repository' : 'repositories'}{' '}
                  included
                </p>
                {!filtered.length ? (
                  <StatePanel kind="empty" heading="h3" title="No repositories match" description="Try another name.">
                    <Button variant="outline" onClick={() => setSearch('')}>
                      Clear repository search
                    </Button>
                  </StatePanel>
                ) : (
                  <GitHubRepositoryChoices
                    legend="Included repositories"
                    value={visible.filter(item => !excluded.has(item.repositoryId)).map(item => item.repositoryId)}
                    options={visible.map(item => ({
                      repositoryId: item.repositoryId,
                      fullName: item.fullName,
                      visibility: item.visibility,
                      detail: item.indexedBy ? `indexed by ${item.indexedBy.title}` : undefined,
                    }))}
                    error={attempted && !included ? 'Keep at least one repository, or remove the source.' : undefined}
                    onValueChange={ids =>
                      setExcluded(current => {
                        const next = new Set(current);
                        for (const item of visible)
                          if (ids.includes(item.repositoryId)) next.delete(item.repositoryId);
                          else next.add(item.repositoryId);
                        return next;
                      })
                    }
                  />
                )}
                <div className="flex flex-wrap gap-2">
                  {filtered.length > limit && (
                    <Button variant="ghost" onClick={() => setLimit(value => value + 50)}>
                      Show more repositories
                    </Button>
                  )}
                  {excluded.size > 0 && (
                    <Button variant="ghost" onClick={() => setExcluded(new Set())}>
                      Include all repositories
                    </Button>
                  )}
                </div>
              </>
            )}
          </section>
          <section aria-label="Content to index" className="space-y-3 border-t pt-4">
            <h5 className="text-sm font-medium">Content</h5>
            <GitHubContentOptions
              idPrefix={`${formId}-content`}
              value={content}
              onChange={setContent}
              attempted={attempted}
            />
          </section>
        </fieldset>
        <CommandFeedback state={command.state} retry={command.retry} />
        <FormFooter
          form={formId}
          layout="compact"
          dirty={dirty}
          submit={{
            label: 'Save source settings',
            pendingLabel: 'Saving source settings…',
            state: command.state.kind === 'sending' ? { kind: 'busy' } : { kind: 'ready' },
          }}
          error={
            attempted && (!checked.valid || !included) ? 'Review the highlighted settings before saving.' : undefined
          }
        >
          <Button variant="ghost" disabled={command.locked} onClick={onClose}>
            Cancel
          </Button>
        </FormFooter>
        <p className="text-xs text-muted-foreground">
          Excluded repositories and content leave Knowledge right away. Changed dates and path patterns apply on the
          next sync.
        </p>
      </Form>
    </section>
  );
}
