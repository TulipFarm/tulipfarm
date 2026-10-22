import { useEffect, useRef, useState } from 'react';
import { RotateCcw, Send, ShieldCheck } from 'lucide-react';
import {
  agentAuthoringLimits,
  isAgentAuthoringSourceCurrent,
  previewAgentChatSchema,
  type AgentAuthoringSource,
  type AgentPreviewReply,
  type PreviewAgentChat,
} from '@tulipfarm/agents/authoring-assistance-contracts';
import { Button } from '@tulipfarm/sprout/button';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { Field } from '@tulipfarm/sprout/field';
import { Form } from '@tulipfarm/sprout/form';
import { Textarea } from '@tulipfarm/sprout/textarea';
import { TableRequestError } from '@/features/tables/request-state';
import { agentAuthoringApi } from './authoring-assistance-api';
import type { AgentInput } from './api';

export function useBuilderTestChat(
  workspaceId: string,
  definition: AgentInput['definition'],
  source: AgentAuthoringSource,
) {
  const [messages, setMessages] = useState<PreviewAgentChat['messages']>([]);
  const [reply, setReply] = useState<AgentPreviewReply | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const controller = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      controller.current?.abort();
    },
    [],
  );
  const stale = !!reply && !isAgentAuthoringSourceCurrent(reply.source, source);
  const reset = () => {
    if (!controller.current) {
      setMessages([]);
      setReply(null);
      setError('');
    }
  };
  async function send() {
    if (controller.current || stale) return;
    const parsed = previewAgentChatSchema.safeParse({
      requestId: crypto.randomUUID(),
      source,
      definition,
      messages: [...messages, { role: 'user', content: text.trim() }],
      ...(reply ? { snapshotId: reply.snapshotId } : {}),
    });
    if (!parsed.success) {
      setError(
        messages.length >= agentAuthoringLimits.messages - 1
          ? 'Reset the test to start another conversation.'
          : 'Add an agent name, instructions, and a message. Keep this test conversation below 32,000 characters.',
      );
      return;
    }
    const pending = new AbortController();
    controller.current = pending;
    setBusy(true);
    setError('');
    try {
      const result = await agentAuthoringApi(workspaceId).preview(parsed.data, pending.signal);
      if (!pending.signal.aborted) {
        setMessages([...parsed.data.messages, { role: 'assistant', content: result.text }]);
        setText('');
        setReply(result);
      }
    } catch (error) {
      setError(
        pending.signal.aborted
          ? 'Test cancelled. Credits may apply for work already done.'
          : error instanceof TableRequestError
            ? error.message
            : 'Could not confirm the test reply. Your draft and message are kept. Check workspace credits before retrying.',
      );
    } finally {
      controller.current = null;
      setBusy(false);
    }
  }
  return { messages, reply, text, setText, busy, error, stale, reset, send, cancel: () => controller.current?.abort() };
}

export function BuilderTestChat({
  chat,
  disabled,
}: {
  chat: ReturnType<typeof useBuilderTestChat>;
  disabled: boolean;
}) {
  return (
    <div className="grid gap-4">
      <div className="flex items-start gap-2 text-sm text-muted-foreground">
        <ShieldCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        <p>
          Test instructions and tone only. No tools, private data, memory, or real actions. Each reply uses workspace
          credits.
        </p>
      </div>
      {!chat.messages.length && (
        <p className="py-6 text-center text-sm text-muted-foreground">
          Ask a sample question to see how this agent responds.
        </p>
      )}
      {chat.messages.length > 0 && (
        <ol aria-label="Test conversation" className="grid max-h-96 gap-4 overflow-auto">
          {chat.messages.map((message, index) => (
            <li key={index} className="grid gap-1">
              <span className="text-xs font-medium text-muted-foreground">
                {message.role === 'user' ? 'You' : 'Agent'}
              </span>
              <p className="whitespace-pre-wrap wrap-anywhere text-sm leading-relaxed">{message.content}</p>
            </li>
          ))}
        </ol>
      )}
      {chat.stale && (
        <Alert>
          <AlertDescription>This test used an earlier draft. Reset it to test your current choices.</AlertDescription>
        </Alert>
      )}
      {chat.error && (
        <Alert variant="destructive">
          <AlertDescription>{chat.error}</AlertDescription>
        </Alert>
      )}
      <Form
        label="Agent test chat"
        disabled={disabled || chat.busy || chat.stale}
        onSubmit={() => {
          void chat.send();
        }}
      >
        <div className="grid gap-3">
          <Field id="agent-test-question" label="Sample message" required>
            <Textarea
              rows={3}
              maxLength={agentAuthoringLimits.message}
              value={chat.text}
              onChange={event => chat.setText(event.target.value)}
              placeholder="How should I request time off?"
            />
          </Field>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" disabled={disabled || chat.busy || chat.stale || !chat.text.trim()}>
              <Send aria-hidden="true" />
              {chat.busy ? 'Testing…' : 'Send test'}
            </Button>
            {chat.busy ? (
              <Button variant="outline" onClick={chat.cancel}>
                Cancel test
              </Button>
            ) : (
              (chat.messages.length > 0 || chat.error) && (
                <Button variant="ghost" onClick={chat.reset}>
                  <RotateCcw aria-hidden="true" />
                  Reset test
                </Button>
              )
            )}
          </div>
        </div>
      </Form>
      {chat.busy && (
        <p role="status" className="text-sm text-muted-foreground">
          Generating a tool-free reply…
        </p>
      )}
      {chat.reply && (
        <p className="text-xs text-muted-foreground">
          Last reply: {chat.reply.usage.credits.toLocaleString(undefined, { maximumFractionDigits: 4 })} credits
        </p>
      )}
    </div>
  );
}
