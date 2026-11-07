import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { BrandIcon } from '@tulipfarm/sprout/brand-icon';
import type { RichTextKeyword, RichTextKeywordAccount } from '@tulipfarm/sprout/rich-text-editor';
import { githubApi } from '@/lib/github';
import { slackSenderApi, type SlackChatSender } from '@/lib/slack-sender';
import { integrations } from './catalog';
import { useGitHubAccounts, useGitHubSelection, useIntegrationChanges, useSlackChatSender } from './queries';
import { statusOf, useIntegrationStatus, type Status } from './status';

// Loading and failed reads stay neutral, so a chip only says "disconnected" when that is known.
const disconnected = new Set<Status['kind']>(['off', 'attention', 'unavailable']);

const slackSenders: RichTextKeywordAccount[] = [
  { id: 'user', label: 'Your Slack account' },
  { id: 'app', label: 'TulipFarm app' },
];

// People type the short product name ("slides", "sheet"). Calendar and Forms are left out: TulipFarm has its own.
const aliases: Record<string, readonly string[]> = {
  'Google Drive': ['Drive'],
  'Google Sheets': ['Sheets', 'Sheet'],
  'Google Docs': ['Docs'],
  'Google Slides': ['Slides'],
  'Microsoft 365': ['Outlook', 'OneDrive'],
};

/**
 * Integration names typed in a message show as chips with the app's logo and whether it is connected.
 * With a chat, the GitHub chip lists the person's accounts and switches the one the chat uses, and the Slack
 * chip switches between posting as the person or as the TulipFarm app. A draft chat keeps both choices until
 * `applyDraft` saves them once the chat exists.
 */
export function useIntegrationKeywords(
  workspaceId: string,
  workspaceSlug: string,
  returnChat?: string,
  chat?: { id: string; draft: boolean },
) {
  const navigate = useNavigate();
  const changes = useIntegrationChanges();
  const { statuses } = useIntegrationStatus(workspaceId);
  const githubAccounts = useGitHubAccounts(workspaceId, !!chat);
  const selection = useGitHubSelection(workspaceId, chat?.id ?? '', false, !!chat && !chat.draft);
  const [draft, setDraft] = useState<{ chatId: string; accountId: string } | null>(null);
  const draftChoice = draft && draft.chatId === chat?.id ? draft.accountId : null;
  const slackConnected = statuses.slack.kind === 'connected';
  const slackSender = useSlackChatSender(workspaceId, chat?.id ?? '', !!chat && !chat.draft && slackConnected);
  const [slackDraft, setSlackDraft] = useState<{ chatId: string; sender: SlackChatSender['sender'] } | null>(null);
  const slackDraftChoice = slackDraft && slackDraft.chatId === chat?.id ? slackDraft.sender : null;
  // A new chat can't ask the server yet, so it offers the app and the send reports if the app can't post.
  const slackChoice =
    chat && slackConnected
      ? chat.draft
        ? { sender: slackDraftChoice ?? 'user', appAvailable: true }
        : slackSender.state.kind === 'ready'
          ? slackSender.state.data
          : null
      : null;
  const accounts: RichTextKeywordAccount[] =
    chat && githubAccounts.state.kind === 'ready'
      ? githubAccounts.state.data.accounts.flatMap(account =>
          account.state === 'active' && account.identity ? [{ id: account.id, label: account.identity.login }] : [],
        )
      : [];
  const selectedId = chat?.draft
    ? draftChoice
    : selection.state.kind === 'ready'
      ? selection.state.data.accountId
      : null;
  const selected = accounts.find(account => account.id === selectedId) ?? (accounts.length === 1 ? accounts[0] : null);
  const keywords: RichTextKeyword[] = integrations.flatMap(app => {
    const status = statusOf(statuses, app);
    const github = app.provider === 'github-personal' && accounts.length > 0;
    const slack = app.provider === 'slack' && slackChoice;
    if (slack)
      return [
        {
          id: app.id,
          label: app.name,
          match: [app.name, ...(aliases[app.name] ?? [])],
          icon: <BrandIcon brand={app.brand} size="inline" />,
          connected: true,
          // With a Switch menu, `account` is the menu's id so the current choice is ticked.
          ...(slack.appAvailable
            ? { account: slack.sender, accounts: slackSenders }
            : { account: slackSenders.find(sender => sender.id === slack.sender)?.label }),
        },
      ];
    return [
      {
        id: app.id,
        label: app.name,
        match: [app.name, ...(aliases[app.name] ?? [])],
        icon: <BrandIcon brand={app.brand} size="inline" />,
        // Workflow apps run without an account connection; "soon" apps can't be used yet.
        connected: status ? !disconnected.has(status.kind) : app.provider !== 'soon',
        account:
          github && selected
            ? accounts.length > 1
              ? selected.id
              : selected.label
            : status?.kind === 'connected'
              ? (status.detail ?? undefined)
              : undefined,
        ...(github && accounts.length > 1 ? { accounts } : {}),
      },
    ];
  });
  const connect = (keyword: RichTextKeyword) =>
    void navigate({
      to: '/$workspaceSlug/integrations',
      params: { workspaceSlug },
      search: { returnChat },
      hash: keyword.id,
    });
  async function select(chatId: string, accountId: string) {
    const current = await githubApi.selection(workspaceId, chatId);
    if (current.accountId !== accountId) await githubApi.select(workspaceId, chatId, accountId, current.version);
    await changes.selection(chatId);
  }
  async function selectSlack(chatId: string, sender: SlackChatSender['sender']) {
    const current = await slackSenderApi.read(workspaceId, chatId);
    if (current.sender !== sender) await slackSenderApi.select(workspaceId, chatId, sender, current.version);
    // By chat id: after a draft's first send, this closure's read still points at the draft.
    await changes.slackSender(chatId);
  }
  const switchAccount = async (keyword: RichTextKeyword, accountId: string) => {
    if (!chat) return;
    if (keyword.id === 'slack' && (accountId === 'user' || accountId === 'app')) {
      if (chat.draft) setSlackDraft({ chatId: chat.id, sender: accountId });
      else await selectSlack(chat.id, accountId);
      return;
    }
    if (keyword.id !== 'github') return;
    if (chat.draft) setDraft({ chatId: chat.id, accountId });
    else await select(chat.id, accountId);
  };
  /** Saves the account picked in a draft once its first message created the chat. */
  const applyDraft = async (chatId: string) => {
    if (draftChoice) await select(chatId, draftChoice);
    if (slackDraftChoice === 'app') await selectSlack(chatId, 'app');
  };
  return { keywords, connect, switchAccount, applyDraft };
}
