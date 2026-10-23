import { useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { XIcon } from 'lucide-react';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@tulipfarm/sprout/accordion';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { Button } from '@tulipfarm/sprout/button';
import { CheckboxField, ChoiceGroup, Field } from '@tulipfarm/sprout/field';
import { Form, FormFooter } from '@tulipfarm/sprout/form';
import { Popover, PopoverContent, PopoverTrigger } from '@tulipfarm/sprout/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tulipfarm/sprout/select';
import { SearchField } from '@tulipfarm/sprout/search-field';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import type { GitHubAccount } from '@/lib/github';
import { useFeatureRead, useFeatureScope } from '@/lib/query';
import {
  GitHubKnowledgeError,
  githubConcealKeys,
  githubCorpusLimits,
  githubCorpusSelectionSchema,
  githubKnowledgeErrorMessages,
  githubSourceKeys,
  type ConfigureGitHub,
  type GitHubKnowledgeApi,
  type GitHubRepositoryChoice,
  type GitHubSource,
} from './github-knowledge-api';
import { discoverGitHubRepositories, filterGitHubRepositories } from './github-repositories';
import { CommandFeedback, ReadResult, useCommand } from './slack-knowledge-shared';
import {
  checkGitHubContent,
  defaultGitHubContent,
  describeGitHubContent,
  GitHubContentOptions,
} from './github-knowledge-content';

const repositoryLimit = githubCorpusLimits.repositories;
const reconnectErrors = new Set([
  'github-not-linked',
  'github-reconnect-required',
  'github-insufficient-scope',
  'github-unauthenticated',
]);

export function GitHubSelectionForm({
  api,
  accounts,
  onSaved,
  onClose,
  onReconnect,
  accountBusy = false,
  footerTarget,
}: {
  api: GitHubKnowledgeApi;
  accounts: GitHubAccount[];
  onSaved: (source: GitHubSource) => Promise<void>;
  onClose: () => void;
  onReconnect?: ((id: string) => void) | undefined;
  accountBusy?: boolean;
  footerTarget: HTMLElement | null;
}) {
  const formId = useId();
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? '');
  const [pendingAccount, setPendingAccount] = useState<string | null>(null);
  const [selected, setSelected] = useState<GitHubRepositoryChoice[]>([]);
  const [mode, setMode] = useState<'all' | 'chosen'>('all');
  const [content, setContent] = useState(defaultGitHubContent);
  const [shared, setShared] = useState(false);
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const [memberSearch, setMemberSearch] = useState('');
  const [search, setSearch] = useState('');
  const [owner, setOwner] = useState('');
  const [limit, setLimit] = useState(50);
  const [attempted, setAttempted] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const searchRegion = useRef<HTMLDivElement>(null);
  const scope = useFeatureScope();
  const discovery = useFeatureRead({
    key: [...githubSourceKeys, 'discover-all', accountId],
    staleTime: 0,
    enabled: !!accountId,
    load: signal =>
      discoverGitHubRepositories(api, accountId, signal).then(
        items => ({ items, blocked: null as string | null }),
        (error: unknown) => {
          if (error instanceof GitHubKnowledgeError && githubKnowledgeErrorMessages[error.code])
            return { items: [], blocked: error.code };
          throw error;
        },
      ),
  });
  const members = useFeatureRead({ key: [...githubSourceKeys, 'members'], load: api.members, enabled: shared });
  const command = useCommand<ConfigureGitHub, GitHubSource>(
    (input, signal) => api.configure(input, signal),
    onSaved,
    githubConcealKeys,
  );
  const selectedAccount = accounts.find(account => account.id === accountId);
  const repositories = selected.map(item => item.fullName).sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1));
  const checked = checkGitHubContent(content);
  const selection = githubCorpusSelectionSchema.safeParse({
    ...(mode === 'all' ? { scope: 'all', repositories: [] } : { repositories }),
    kinds: checked.kinds,
    ...(checked.excludePaths.length ? { excludePaths: checked.excludePaths } : {}),
    ...(checked.after ? { after: checked.after } : {}),
  });
  const candidates =
    members.state.kind === 'ready'
      ? members.state.data.members.filter(member => scope.kind !== 'workspace' || member.id !== scope.membershipId)
      : [];
  const visibleMembers = candidates.filter(member =>
    `${member.name} ${member.email}`.toLowerCase().includes(memberSearch.toLowerCase()),
  );
  const audienceReady =
    !shared ||
    (members.state.kind === 'ready' &&
      !members.state.error &&
      memberIds.length > 0 &&
      memberIds.every(id => candidates.some(member => member.id === id)));
  const discoveryReady = discovery.state.kind === 'ready' && !discovery.state.error && !discovery.state.data.blocked;
  const busy = command.state.kind === 'sending';
  function changeAccount(id: string) {
    setAccountId(id);
    setSelected([]);
    setSearch('');
    setOwner('');
    setLimit(50);
    setAttempted(false);
    setPendingAccount(null);
  }
  const blockedReason = pendingAccount
    ? 'Keep this account or confirm the switch before saving.'
    : command.state.kind === 'uncertain'
      ? 'Retry the same operation below to confirm the save.'
      : !discoveryReady
        ? 'Load the repository list before adding to Knowledge.'
        : null;
  const importSettings = (
    <div className="rounded-lg bg-muted px-3 pb-3">
      <Accordion
        value={settingsOpen ? ['settings'] : []}
        onValueChange={value => setSettingsOpen(value.includes('settings'))}
      >
        <AccordionItem value="settings">
          <AccordionTrigger>Import settings</AccordionTrigger>
          <AccordionContent>
            <div className="space-y-5 pt-2">
              <GitHubContentOptions
                idPrefix={`${formId}-content`}
                value={content}
                onChange={setContent}
                attempted={attempted}
              />
              <section aria-label="Who can access this content" className="space-y-3 border-t pt-4">
                <h4 className="text-sm font-medium">Who can access this content?</h4>
                <CheckboxField
                  label="Share with selected workspace members"
                  checked={shared}
                  onCheckedChange={setShared}
                  helper="Selected readers must also have their own GitHub access to each repository."
                  error={
                    attempted && !audienceReady
                      ? 'Load the current workspace members and select at least one reader, or turn off sharing to keep this source private.'
                      : undefined
                  }
                />
                {shared && (
                  <ReadResult state={members.state} retry={members.refresh} label="workspace members">
                    {() => (
                      <div className="space-y-3">
                        <SearchField label="Find source readers" value={memberSearch} onChange={setMemberSearch} />
                        {!candidates.length ? (
                          <p className="text-sm">No other current workspace members are available.</p>
                        ) : !visibleMembers.length ? (
                          <StatePanel
                            kind="empty"
                            heading="h3"
                            title="No members match"
                            description="Try another name or email."
                          >
                            <Button variant="outline" onClick={() => setMemberSearch('')}>
                              Clear member search
                            </Button>
                          </StatePanel>
                        ) : (
                          <ChoiceGroup
                            type="checkbox"
                            legend="Readers"
                            required
                            value={memberIds}
                            onValueChange={setMemberIds}
                            options={visibleMembers.map(member => ({
                              value: member.id,
                              label: `${member.name || member.email} (${member.email})`,
                              disabled: memberIds.length >= 100 && !memberIds.includes(member.id),
                            }))}
                          />
                        )}
                        <p className="text-xs text-muted-foreground">
                          {memberIds.length} readers selected, plus you. Workspace admins get no automatic access.
                        </p>
                      </div>
                    )}
                  </ReadResult>
                )}
              </section>
            </div>
          </AccordionContent>
        </AccordionItem>
      </Accordion>
      {!settingsOpen && (
        <p className="text-xs leading-relaxed text-muted-foreground">
          {content.kinds.length ? describeGitHubContent(checked) : 'Choose content'} ·{' '}
          {shared ? `${memberIds.length} readers + you` : 'only you'}
        </p>
      )}
    </div>
  );
  const footer = (
    <div>
      <CommandFeedback state={command.state} retry={command.retry} />
      <FormFooter
        form={formId}
        layout="compact"
        dirty={mode === 'all' || selected.length > 0}
        summary={
          <p role="status" className="text-sm font-medium">
            {mode === 'all'
              ? 'All repositories'
              : `${selected.length.toLocaleString()} / ${repositoryLimit.toLocaleString()} selected`}
          </p>
        }
        submit={{
          label: 'Add to Knowledge',
          pendingLabel: 'Adding to Knowledge…',
          state: busy
            ? { kind: 'busy' }
            : blockedReason
              ? { kind: 'blocked', reason: blockedReason }
              : { kind: 'ready' },
        }}
        error={
          attempted && (!selection.success || !checked.valid || !audienceReady)
            ? 'Review the highlighted choices before adding to Knowledge.'
            : undefined
        }
      >
        <Button variant="ghost" aria-label="Cancel selection" disabled={command.locked} onClick={onClose}>
          Cancel
        </Button>
      </FormFooter>
      {command.locked && (
        <p role="status" className="pt-2 text-xs text-muted-foreground">
          Keep this selection open until the save is confirmed. A timed-out request may still complete.
        </p>
      )}
    </div>
  );
  return (
    <section aria-label="Select GitHub repositories" className="space-y-4">
      <Form
        id={formId}
        label="Add repositories to Knowledge"
        disabled={command.locked}
        onSubmit={() => {
          if (command.locked || pendingAccount || !discoveryReady || !accountId) return;
          setAttempted(true);
          if (!selection.success || !checked.valid || !audienceReady) {
            if (!checked.valid || !audienceReady) setSettingsOpen(true);
            return 'invalid';
          }
          void command.send({
            commandId: crypto.randomUUID(),
            accountId,
            selection: selection.data,
            memberIds: shared ? memberIds : [],
          });
        }}
      >
        <fieldset disabled={command.locked} className="min-w-0 space-y-5">
          {accounts.length > 1 ? (
            <Field
              label="Use GitHub account"
              required
              helper="This login supplies access. Filter repository owners below."
            >
              <Select
                value={accountId}
                onValueChange={id => {
                  if (id && id !== accountId) {
                    if (selected.length) setPendingAccount(id);
                    else changeAccount(id);
                  }
                }}
              >
                <SelectTrigger width="full">
                  <SelectValue>
                    {selectedAccount?.identity ? `@${selectedAccount.identity.login}` : 'Choose a GitHub account'}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {accounts.map(account => (
                    <SelectItem key={account.id} value={account.id}>
                      @{account.identity?.login}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          ) : null}
          {pendingAccount && (
            <Alert>
              <AlertDescription>
                Switching accounts clears your {selected.length} selected{' '}
                {selected.length === 1 ? 'repository' : 'repositories'}. Import settings will be kept.
              </AlertDescription>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button variant="outline" onClick={() => changeAccount(pendingAccount)}>
                  Switch account and clear selection
                </Button>
                <Button variant="ghost" onClick={() => setPendingAccount(null)}>
                  Keep this account
                </Button>
              </div>
            </Alert>
          )}
          <ChoiceGroup
            type="radio"
            legend="Repositories to index"
            required
            value={mode}
            onValueChange={setMode}
            options={[
              {
                value: 'all',
                label: 'All repositories',
                description:
                  'Every repository this account can read, including new ones. Leave repositories out later in the source settings.',
              },
              {
                value: 'chosen',
                label: 'Only repositories I choose',
                description: `Pick up to ${repositoryLimit.toLocaleString()} repositories.`,
              },
            ]}
          />
          <div ref={searchRegion} className="space-y-3">
            <ReadResult state={discovery.state} retry={discovery.refresh} label="GitHub repositories">
              {data => {
                if (data.blocked)
                  return (
                    <StatePanel
                      kind="unavailable"
                      heading="h3"
                      title="GitHub repositories unavailable"
                      description={githubKnowledgeErrorMessages[data.blocked]!}
                    >
                      {onReconnect && reconnectErrors.has(data.blocked) && (
                        <Button variant="outline" disabled={accountBusy} onClick={() => onReconnect(accountId)}>
                          Reconnect GitHub account
                        </Button>
                      )}
                      <Button variant="ghost" onClick={() => void discovery.refresh()}>
                        Check GitHub again
                      </Button>
                    </StatePanel>
                  );
                if (mode === 'all')
                  return (
                    <>
                      <p role="status" className="text-sm">
                        {data.items.length.toLocaleString()} {data.items.length === 1 ? 'repository' : 'repositories'}{' '}
                        will be indexed now. New repositories are added on each sync.
                      </p>
                      {importSettings}
                    </>
                  );
                const owners = [...new Set(data.items.map(item => item.fullName.split('/')[0]!))].sort((a, b) =>
                  a.localeCompare(b),
                );
                const filtered = filterGitHubRepositories(data.items, search, owner);
                const visible = filtered.slice(0, limit);
                return (
                  <>
                    <div className="flex flex-wrap items-end gap-3">
                      <div className="min-w-0 flex-1 basis-56">
                        <SearchField
                          label="Find repositories"
                          placeholder="Search all repositories…"
                          value={search}
                          onChange={value => {
                            setSearch(value);
                            setLimit(50);
                          }}
                        />
                      </div>
                      <div className="min-w-0 flex-1 basis-40 sm:max-w-56">
                        <Field label="Repository owner" labelVisibility="screen-reader" optional>
                          <Select
                            value={owner || '__all__'}
                            onValueChange={value => {
                              setOwner(value === '__all__' ? '' : (value ?? ''));
                              setLimit(50);
                            }}
                          >
                            <SelectTrigger width="full">
                              <SelectValue>{owner || 'All owners'}</SelectValue>
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="__all__">All owners</SelectItem>
                              {owners.map(name => (
                                <SelectItem key={name} value={name}>
                                  {name}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </Field>
                      </div>
                    </div>
                    {importSettings}
                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                      <p role="status">
                        {owner || search.trim()
                          ? `${filtered.length} of ${data.items.length} repositories`
                          : `${data.items.length} ${data.items.length === 1 ? 'repository' : 'repositories'}`}
                      </p>
                      <Popover>
                        <PopoverTrigger render={<Button variant="ghost" size="sm" />}>
                          Missing a repository?
                        </PopoverTrigger>
                        <PopoverContent align="end">
                          <p>
                            Your GitHub login includes repositories you own and those shared with you. Organizations may
                            require owner approval or SSO authorization.
                          </p>
                          <p>
                            Check organization access for TulipFarm in{' '}
                            <a
                              className="underline underline-offset-4"
                              href="https://github.com/settings/applications"
                              target="_blank"
                              rel="noreferrer"
                            >
                              GitHub Settings → Applications → Authorized OAuth Apps
                            </a>
                            , then reopen this picker.
                          </p>
                        </PopoverContent>
                      </Popover>
                    </div>
                    {!data.items.length ? (
                      <StatePanel
                        kind="empty"
                        heading="h3"
                        title="No repositories available"
                        description="GitHub returned no repositories for this integration. Check organization access in GitHub or use another connected account."
                      >
                        <Button variant="outline" onClick={() => void discovery.refresh()}>
                          Check GitHub repositories again
                        </Button>
                      </StatePanel>
                    ) : !filtered.length ? (
                      <StatePanel
                        kind="empty"
                        heading="h3"
                        title="No repositories match"
                        description="Try a different name or repository owner."
                      >
                        <Button
                          variant="outline"
                          onClick={() => {
                            setSearch('');
                            setOwner('');
                            setLimit(50);
                          }}
                        >
                          Clear filters
                        </Button>
                      </StatePanel>
                    ) : (
                      <div role="region" aria-label="Available repositories">
                        <ChoiceGroup
                          type="checkbox"
                          legend="Repositories"
                          legendVisibility="screen-reader"
                          required
                          value={selected.map(item => item.repositoryId)}
                          options={visible.map(item => ({
                            value: item.repositoryId,
                            label: `${item.fullName}${item.visibility === 'public' ? '' : ` (${item.visibility})`}`,
                            disabled:
                              selected.length >= repositoryLimit &&
                              !selected.some(value => value.repositoryId === item.repositoryId),
                          }))}
                          error={
                            attempted && !selected.length
                              ? 'Choose at least one GitHub repository before saving.'
                              : undefined
                          }
                          onValueChange={ids =>
                            setSelected(current => [
                              ...current.filter(
                                item =>
                                  !visible.some(value => value.repositoryId === item.repositoryId) ||
                                  ids.includes(item.repositoryId),
                              ),
                              ...visible.filter(
                                item =>
                                  ids.includes(item.repositoryId) &&
                                  !current.some(value => value.repositoryId === item.repositoryId),
                              ),
                            ])
                          }
                        />
                        {filtered.length > limit && (
                          <div className="pt-2">
                            <Button variant="ghost" onClick={() => setLimit(value => value + 50)}>
                              Show more repositories
                            </Button>
                          </div>
                        )}
                      </div>
                    )}
                  </>
                );
              }}
            </ReadResult>
            {discovery.state.kind === 'loading' && (
              <p className="text-xs text-muted-foreground">
                Checking all repository pages, including organizations. Search will cover the complete list.
              </p>
            )}
            {mode === 'chosen' && selected.length > 0 && (
              <section aria-label="Selected repositories" className="space-y-2">
                {selected.length > 0 && (
                  <ul className="flex flex-wrap gap-2">
                    {selected.map(item => (
                      <li
                        key={item.repositoryId}
                        className="flex max-w-full items-center gap-1 rounded-md bg-muted pl-2 text-xs"
                      >
                        <span className="min-w-0 break-all">{item.fullName}</span>
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          aria-label={`Remove ${item.fullName}`}
                          onClick={() => {
                            setSelected(current => current.filter(value => value.repositoryId !== item.repositoryId));
                            searchRegion.current?.querySelector<HTMLInputElement>('input[type="search"]')?.focus();
                          }}
                        >
                          <XIcon aria-hidden="true" />
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
                {selected.length >= repositoryLimit && (
                  <p className="text-xs text-muted-foreground">
                    Selection limit reached. Remove a repository to choose another.
                  </p>
                )}
              </section>
            )}
          </div>
        </fieldset>
        {footerTarget ? createPortal(footer, footerTarget) : footer}
      </Form>
    </section>
  );
}
