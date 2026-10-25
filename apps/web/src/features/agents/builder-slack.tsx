import { useEffect, useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Plus, X } from 'lucide-react';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { Badge } from '@tulipfarm/sprout/badge';
import { Button } from '@tulipfarm/sprout/button';
import { BrandIcon } from '@tulipfarm/sprout/brand-icon';
import { CheckboxField, ChoiceGroup, Field } from '@tulipfarm/sprout/field';
import { FormSection } from '@tulipfarm/sprout/form';
import { Input } from '@tulipfarm/sprout/input';
import { Disclosure } from '@/components/disclosure';
import { SlackChannelName } from '@/components/slack-channel-name';
import { SlackChannelPicker } from './slack-channel-picker';
import { TableRequestError } from '@/features/tables/request-state';
import { useAgentSlackApi, useAgentSlackChoices } from './slack-queries';
import { AgentRead } from './feedback';
import { AgentName } from './reference-names';

export type BuilderChannel = {
  channel: string;
  name: string;
  expectedVersion: number;
  replaceAgentId: string | null;
  channelResponses: boolean | null;
  replaceConsent: boolean;
  detach?: boolean | undefined;
  /** Known only for channels picked from the list in this session; saved drafts don't record it. */
  private?: boolean | undefined;
};

export function BuilderSlack({
  workspaceId,
  slug,
  agentId,
  value,
  onChange,
  rule,
  onRule,
  disabled,
  showErrors,
  enabled,
}: {
  workspaceId: string;
  slug: string;
  agentId: string;
  value: BuilderChannel[];
  onChange: (value: BuilderChannel[]) => void;
  rule: 'tag' | 'every-message';
  onRule: (rule: 'tag' | 'every-message') => void;
  disabled: boolean;
  showErrors: boolean;
  enabled: boolean;
}) {
  const [cursor, setCursor] = useState<string | null>(null);
  const [channel, setChannel] = useState('');
  const [error, setError] = useState('');
  const [checking, setChecking] = useState(false);
  const pending = useRef<AbortController | null>(null);
  const api = useAgentSlackApi(workspaceId);
  const choices = useAgentSlackChoices(workspaceId, cursor, enabled);
  useEffect(
    () => () => {
      pending.current?.abort();
    },
    [],
  );
  async function check(id: string, name: string, isPrivate?: boolean) {
    if (disabled || pending.current) return;
    if (!/^[CG][A-Z0-9]{1,63}$/.test(id)) {
      setError('Use a public or private Slack channel ID, starting with C or G.');
      return;
    }
    const controller = new AbortController();
    pending.current = controller;
    setChecking(true);
    setError('');
    try {
      const current = await api.channel(id, controller.signal);
      if (current.occupied && !current.agentId) {
        setError('Another agent is attached here and you cannot replace it. Ask its manager to change the attachment.');
        return;
      }
      if (!controller.signal.aborted) {
        const previous = value.find(item => item.channel === id);
        const checked = {
          ...previous,
          channel: id,
          name,
          private: isPrivate ?? previous?.private,
          expectedVersion: current.version,
          replaceAgentId: current.agentId,
          channelResponses: current.channelResponses,
          replaceConsent: false,
        };
        onChange(previous ? value.map(item => (item.channel === id ? checked : item)) : [...value, checked]);
        setChannel('');
      }
    } catch (error) {
      if (!controller.signal.aborted)
        setError(
          error instanceof TableRequestError
            ? error.message
            : 'Could not check this channel. No attachment was changed. Try again.',
        );
    } finally {
      pending.current = null;
      setChecking(false);
    }
  }
  return (
    <FormSection
      title="Slack channels"
      description="Attach this agent to channels when you activate. The bot and each caller must have current channel access."
    >
      <div className="flex items-center gap-2 text-sm">
        <BrandIcon brand="slack" size="inline" />
        <span>Linked workspace members can talk to this agent in these channels.</span>
      </div>
      <AgentRead state={choices.state} refresh={choices.refresh}>
        {data =>
          data.kind === 'unavailable' ? (
            <div className="grid gap-3">
              <p className="text-sm text-muted-foreground">{data.message}</p>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  nativeButton={false}
                  render={
                    <Link
                      to="/$workspaceSlug/integrations"
                      params={{ workspaceSlug: slug }}
                      target="_blank"
                      rel="noopener noreferrer"
                    />
                  }
                >
                  Connect or renew Slack
                </Button>
                <Button variant="ghost" onClick={() => void choices.refresh()}>
                  Check integration
                </Button>
              </div>
            </div>
          ) : (
            <div className="grid gap-3">
              <Field
                id="builder-slack-channel"
                label="Add a channel"
                optional
                helper="Only checked channels can be attached. Nothing is posted while drafting."
              >
                <SlackChannelPicker
                  id="builder-slack-channel"
                  items={data.items}
                  placeholder={checking ? 'Checking channel…' : 'Search Slack channels'}
                  disabled={disabled || checking || choices.state.kind !== 'ready' || choices.state.refreshing}
                  isTaken={id => value.some(selected => selected.channel === id)}
                  onPick={item => void check(item.conversationId, item.title, item.kind === 'private')}
                />
              </Field>
              {!data.items.length && (
                <p className="text-sm text-muted-foreground">
                  No eligible channels on this page. Add the bot to a channel and check again.
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                {cursor && (
                  <Button variant="ghost" disabled={checking} onClick={() => setCursor(null)}>
                    First channels
                  </Button>
                )}
                {data.nextCursor && (
                  <Button variant="outline" disabled={checking} onClick={() => setCursor(data.nextCursor)}>
                    More channels
                  </Button>
                )}
                <Button variant="ghost" disabled={checking} onClick={() => void choices.refresh()}>
                  Refresh channels
                </Button>
              </div>
              <Disclosure title="Use a channel ID">
                <div className="grid gap-3">
                  <Field
                    id="builder-slack-channel-id"
                    label="Slack channel ID"
                    optional
                    helper="Copy it from the channel details in Slack."
                  >
                    <Input value={channel} onChange={event => setChannel(event.target.value.trim())} maxLength={64} />
                  </Field>
                  <div>
                    <Button
                      variant="outline"
                      disabled={disabled || checking || !channel}
                      onClick={() => void check(channel, channel)}
                    >
                      <Plus aria-hidden="true" />
                      Check and add channel
                    </Button>
                  </div>
                </div>
              </Disclosure>
            </div>
          )
        }
      </AgentRead>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {checking && (
        <p role="status" className="text-sm text-muted-foreground">
          Checking channel membership and delivery…
        </p>
      )}
      {value.length > 0 && (
        <>
          <ul aria-label="Selected Slack channels" className="grid gap-4">
            {value.map(item => (
              <li key={item.channel} className="grid gap-2 border-t pt-4">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <span className="min-w-0 grow basis-40 text-sm font-medium">
                    <SlackChannelName
                      title={item.name}
                      private={
                        item.private ??
                        (choices.state.kind === 'ready' &&
                          choices.state.data.kind === 'available' &&
                          choices.state.data.items.some(
                            choice => choice.conversationId === item.channel && choice.kind === 'private',
                          ))
                      }
                    />
                  </span>
                  <Badge variant={item.channelResponses ? 'secondary' : 'warning'}>
                    {item.detach
                      ? 'Detach on activation'
                      : item.channelResponses === null
                        ? 'Check needed'
                        : item.channelResponses
                          ? 'Channel replies ready'
                          : 'DM only'}
                  </Badge>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={disabled || checking}
                    onClick={() => void check(item.channel, item.name)}
                  >
                    Recheck
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Remove ${item.name}`}
                    disabled={disabled || checking}
                    onClick={() => onChange(value.filter(channel => channel.channel !== item.channel))}
                  >
                    <X aria-hidden="true" />
                  </Button>
                </div>
                {!item.detach && item.channelResponses === null && (
                  <p className="text-sm text-muted-foreground">
                    Recheck this saved channel before activation. No attachment has changed.
                  </p>
                )}
                {!item.detach && item.channelResponses === false && (
                  <p role="alert" className="text-sm text-muted-foreground">
                    In-channel replies are unavailable. A workspace admin must enable channel delivery before this setup
                    can activate. You can still save a draft.
                  </p>
                )}
                {item.replaceAgentId && item.replaceAgentId !== agentId && (
                  <>
                    <p className="text-sm">
                      Currently attached: <AgentName workspaceId={workspaceId} agentId={item.replaceAgentId} />
                    </p>
                    <CheckboxField
                      id={`replace-${item.channel}`}
                      label="Replace the existing agent for new threads"
                      helper="Existing threads keep their original agent."
                      checked={item.replaceConsent}
                      onCheckedChange={replaceConsent =>
                        onChange(
                          value.map(channel =>
                            channel.channel === item.channel ? { ...channel, replaceConsent } : channel,
                          ),
                        )
                      }
                      error={showErrors && !item.replaceConsent ? 'Confirm replacement before activation.' : undefined}
                    />
                  </>
                )}
              </li>
            ))}
          </ul>
          <ChoiceGroup
            id="builder-response-rule"
            type="radio"
            required
            legend="When should it reply?"
            value={rule}
            onValueChange={onRule}
            options={[
              { value: 'tag', label: 'When mentioned', description: 'Replies to a mention, then follows that thread.' },
              {
                value: 'every-message',
                label: 'Every channel message',
                description: 'Starts a reply for each new message. Applies to all attached channels.',
              },
            ]}
          />
        </>
      )}
      {!value.length && (
        <p className="text-sm text-muted-foreground">No Slack trigger. This agent can still be used manually.</p>
      )}
    </FormSection>
  );
}
