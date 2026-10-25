import { useState } from 'react';
import { Button, type ButtonState } from '@tulipfarm/sprout/button';
import { Field } from '@tulipfarm/sprout/field';
import { Form, FormSection } from '@tulipfarm/sprout/form';
import { Input } from '@tulipfarm/sprout/input';
import { Skeleton } from '@tulipfarm/sprout/skeleton';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { ReadError, ReadFeedback } from '@/components/read-feedback';
import { useTableWrite } from '@/features/tables/use-table-write';
import { WriteFeedback } from '@/features/tables/feedback';
import { useAgentSlackApi, useAgentSlackChannel, useAgentSlackChoices } from './slack-queries';
import { SlackChannelPicker } from './slack-channel-picker';

const channelPattern = /^[CG][A-Z0-9]+$/;

export function AgentSlackChannel({ workspaceId, agentId }: { workspaceId: string; agentId: string }) {
  const [channel, setChannel] = useState('');
  const [manual, setManual] = useState(false);
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const choices = useAgentSlackChoices(workspaceId, cursors.at(-1) ?? null, !manual);
  const [checked, setChecked] = useState<string | null>(null);
  const [showErrors, setShowErrors] = useState(false);
  const api = useAgentSlackApi(workspaceId);
  const read = useAgentSlackChannel(api, channel, checked === channel);
  const write = useTableWrite(
    (input: { channel: string; version: number }) => api.attach(input.channel, agentId, input.version),
    () => {},
  );
  const checking =
    checked === channel && (read.state.kind === 'loading' || (read.state.kind === 'ready' && read.state.refreshing));
  const attaching = write.state.kind === 'sending';
  const attach: ButtonState =
    checking || attaching
      ? { kind: 'busy' }
      : write.state.kind === 'uncertain'
        ? { kind: 'blocked', reason: 'Check the channel again before retrying.' }
        : read.state.kind === 'ready' && read.state.error
          ? { kind: 'blocked', reason: 'The channel check failed. Check the channel again.' }
          : { kind: 'ready' };
  function check() {
    if (write.state.kind === 'uncertain') write.reset();
    if (checked === channel) void read.refresh();
    else setChecked(channel);
  }
  function submit() {
    if (!channelPattern.test(channel)) {
      setShowErrors(true);
      return 'invalid' as const;
    }
    setShowErrors(false);
    check();
  }
  function select(value: string) {
    setChannel(value);
    setChecked(null);
    write.reset();
  }
  const retry = (
    <Button variant="outline" onClick={check}>
      Check channel again
    </Button>
  );
  const retryChoices = (
    <Button
      variant="outline"
      disabled={choices.state.kind === 'ready' && choices.state.refreshing}
      aria-busy={choices.state.kind === 'ready' && choices.state.refreshing}
      onClick={() => void choices.refresh()}
    >
      Retry channel list
    </Button>
  );
  return (
    <FormSection
      title="Slack channel"
      label="Slack channel attachment"
      description="Attach this agent to a Slack channel you can access."
    >
      <Form disabled={checking || attaching} onSubmit={submit}>
        <div className="grid max-w-sm gap-3">
          {manual ? (
            <Field
              id="agent-slack-channel"
              label="Slack channel ID"
              required
              helper="Copy it from the channel details in Slack. The TulipFarm app must be a member."
              error={
                showErrors && !channelPattern.test(channel) ? 'Enter a channel ID that starts with C or G.' : undefined
              }
            >
              <Input value={channel} placeholder="C0123456789" onChange={event => select(event.target.value.trim())} />
            </Field>
          ) : (
            <ReadFeedback
              state={choices.state}
              errorTitle="Could not load Slack channels"
              retry={retryChoices}
              loading={
                <div role="status" aria-label="Loading Slack channels">
                  <Skeleton />
                  <span>Loading Slack channels…</span>
                </div>
              }
              unavailable={() => (
                <StatePanel
                  kind="unavailable"
                  heading="h3"
                  title="Slack channels unavailable"
                  description="Check your linked Slack account and current access. You can also enter a channel ID."
                >
                  {retryChoices}
                </StatePanel>
              )}
              refreshError={message => (
                <ReadError message={`Could not refresh Slack channels. ${message}`}>{retryChoices}</ReadError>
              )}
            >
              {data =>
                data.kind === 'unavailable' ? (
                  <StatePanel
                    kind="unavailable"
                    heading="h3"
                    title="Slack channels unavailable"
                    description={data.message}
                  >
                    {choices.state.kind === 'ready' && !choices.state.error && retryChoices}
                  </StatePanel>
                ) : (
                  <div className="grid gap-3">
                    <Field
                      id="agent-slack-channel"
                      label="Slack channel"
                      required
                      helper="Channels from your linked Slack account. The TulipFarm app must also be a member."
                      error={
                        showErrors && !channelPattern.test(channel)
                          ? 'Choose a Slack channel, or enter its channel ID.'
                          : undefined
                      }
                    >
                      <SlackChannelPicker
                        id="agent-slack-channel"
                        items={data.items}
                        value={channel || null}
                        placeholder="Search Slack channels"
                        invalid={showErrors && !channelPattern.test(channel)}
                        onPick={item => select(item.conversationId)}
                      />
                    </Field>
                    {!data.items.length && (
                      <StatePanel
                        kind="empty"
                        heading="h3"
                        title="No Slack channels on this page"
                        description="Join a channel in Slack, then check again. You can also enter a channel ID."
                      >
                        {choices.state.kind === 'ready' && !choices.state.error && retryChoices}
                      </StatePanel>
                    )}
                    {(cursors.length > 1 || data.nextCursor) && (
                      <nav aria-label="Slack channel pages" className="flex flex-wrap gap-2">
                        <Button
                          variant="outline"
                          disabled={
                            cursors.length === 1 || (choices.state.kind === 'ready' && choices.state.refreshing)
                          }
                          onClick={() => setCursors(current => current.slice(0, -1))}
                        >
                          Previous channels
                        </Button>
                        <Button
                          variant="outline"
                          disabled={!data.nextCursor || (choices.state.kind === 'ready' && choices.state.refreshing)}
                          onClick={() => {
                            if (data.nextCursor) setCursors(current => [...current, data.nextCursor]);
                          }}
                        >
                          Next channels
                        </Button>
                      </nav>
                    )}
                  </div>
                )
              }
            </ReadFeedback>
          )}
          <Button variant="ghost" onClick={() => setManual(value => !value)}>
            {manual ? 'Choose from my Slack channels' : 'Use a channel ID instead'}
          </Button>
          <Button
            type="submit"
            variant="outline"
            state={checking || attaching ? { kind: 'busy' } : { kind: 'ready' }}
            pendingLabel={checking ? 'Checking channel…' : undefined}
          >
            Check channel
          </Button>
        </div>
      </Form>
      {checked === channel && (
        <ReadFeedback
          state={read.state}
          errorTitle="Could not check the channel"
          retry={retry}
          loading={
            <div role="status" aria-label="Loading channel attachment">
              <Skeleton />
            </div>
          }
          unavailable={() => (
            <StatePanel
              kind="unavailable"
              title="Channel unavailable"
              description="You need a linked Slack account, current channel access, and permission to use this agent."
            >
              {retry}
            </StatePanel>
          )}
          refreshError={message => <ReadError message={message} />}
        >
          {value => (
            <div className="grid gap-3">
              <p role="status" className="text-sm">
                {value.agentId === agentId
                  ? 'This agent is already attached.'
                  : value.version === 0
                    ? 'No agent is attached to this channel.'
                    : 'This channel has another assistant. Replacing it affects new threads only.'}
              </p>
              {value.agentId !== agentId && (
                <Button
                  state={attach}
                  pendingLabel={attaching ? 'Attaching agent…' : undefined}
                  onClick={() => void write.submit({ channel, version: value.version })}
                >
                  {value.version === 0 ? 'Attach agent' : 'Replace channel agent'}
                </Button>
              )}
            </div>
          )}
        </ReadFeedback>
      )}
      {attaching && (
        <StatePanel
          kind="loading"
          title="Attaching agent"
          description="Checking your current permissions and channel membership."
        />
      )}
      {write.state.kind === 'accepted' && (
        <StatePanel
          kind="success"
          title="Agent attached"
          description="New invocations use this agent. Its response rule applies across all attached channels."
        />
      )}
      <WriteFeedback
        state={write.state}
        checkStatus={() => {
          check();
          write.reset();
        }}
      />
      <p className="text-sm text-muted-foreground">
        Replies go to people by direct message while channel audience checks are unavailable.
      </p>
    </FormSection>
  );
}
