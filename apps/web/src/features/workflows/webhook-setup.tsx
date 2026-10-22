import { useEffect, useState, type ReactNode } from 'react';
import type { z } from 'zod';
import type { workflowSchema } from '@tulipfarm/workflows/contracts';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from '@tulipfarm/sprout/alert-dialog';
import { Badge } from '@tulipfarm/sprout/badge';
import { Button } from '@tulipfarm/sprout/button';
import { CodeBlock } from '@tulipfarm/sprout/code-block';
import { Input } from '@tulipfarm/sprout/input';
import { Label } from '@tulipfarm/sprout/label';
import { webhookCurl, webhookInstructions, webhookPayload, webhookStatus, type WebhookMode } from './webhook-status';

type Workflow = z.infer<typeof workflowSchema>;
/** A key the server returned for this workflow. `key` is null when a retried request had already created it. */
export type IssuedWebhookKey = { workflowId: string; key: string | null };

const modeLabel: Record<WebhookMode, string> = {
  signed: 'Signed requests (HMAC-SHA256)',
  github: 'GitHub signature',
  stripe: 'Stripe signature',
  bearer: 'Bearer key',
};

export function WebhookSetup({
  hidden,
  workflow,
  url,
  blocked,
  issued,
  onRotate,
  onRevokePrevious,
  onCopied,
  onCopyFailed,
  children,
}: {
  hidden: boolean;
  workflow: Workflow;
  url: string;
  blocked: boolean;
  issued: IssuedWebhookKey | null;
  children?: ReactNode;
  onRotate: (mode: WebhookMode, secret?: string) => void;
  onRevokePrevious: () => void;
  onCopied: () => void;
  onCopyFailed: () => void;
}) {
  const webhook = webhookStatus(workflow);
  const [mode, setMode] = useState<WebhookMode>(
    workflow.webhookRotation ? (workflow.webhookMode ?? 'signed') : 'bearer',
  );
  const [stripeSecret, setStripeSecret] = useState('');
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  useEffect(() => {
    if (workflow.webhookMode === 'stripe') setStripeSecret('');
  }, [workflow.generation, workflow.webhookMode]);
  const shown = issued?.workflowId === workflow.id ? issued : null;
  const payload = webhookPayload(workflow);
  const instructionsMode = workflow.webhookMode ?? mode;
  return (
    <section hidden={hidden} className="max-w-3xl space-y-3" aria-label="Webhook setup">
      <AlertDialog open={confirmRevoke} onOpenChange={setConfirmRevoke}>
        <AlertDialogContent>
          <AlertDialogTitle>Revoke the previous webhook key?</AlertDialogTitle>
          <AlertDialogDescription>
            Requests that still use the previous key are rejected at once. Update every sender to the current key first.
            This cannot be undone.
          </AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep accepting it</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                setConfirmRevoke(false);
                onRevokePrevious();
              }}
            >
              Revoke previous key
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <h2 className="text-lg font-medium">Webhook setup</h2>
      <dl className="space-y-2 text-sm">
        <div aria-label="Webhook key status">
          <dt className="font-medium">Key</dt>
          <dd className="flex flex-wrap items-center gap-2">
            <Badge variant={webhook.configured ? 'success' : 'warning'}>
              {webhook.configured ? 'Configured' : 'Not configured'}
            </Badge>
            {workflow.webhookMode ? `${modeLabel[workflow.webhookMode]}.` : 'No key is saved.'}
          </dd>
        </div>
        {workflow.webhookPrevious && (
          <div aria-label="Previous webhook key status">
            <dt className="font-medium">Previous key</dt>
            <dd className="flex flex-wrap items-center gap-2">
              <Badge variant="warning">Still accepted</Badge>
              {`The previous ${modeLabel[workflow.webhookPrevious.mode].toLowerCase()} keeps working until ${formatTime(workflow.webhookPrevious.expiresAt)}.`}
              <Button variant="outline" disabled={blocked} onClick={() => setConfirmRevoke(true)}>
                Revoke previous key now
              </Button>
            </dd>
          </div>
        )}
        <div aria-label="Webhook endpoint status">
          <dt className="font-medium">Endpoint</dt>
          <dd className="flex flex-wrap items-center gap-2">
            <Badge variant={webhook.receiving ? 'success' : 'warning'}>
              {webhook.receiving ? 'Receiving' : 'Not receiving'}
            </Badge>
            {webhook.endpoint}
          </dd>
        </div>
      </dl>
      {webhook.change && (
        <p role="note" className="text-sm">
          {webhook.change}
        </p>
      )}
      <p className="break-all text-sm">POST {url}</p>
      <p className="text-sm">{webhookInstructions(payload, instructionsMode)}</p>
      <CodeBlock code={webhookCurl(url, payload, instructionsMode)} filename="curl example" lineNumbers={false} />
      <p className="text-sm text-muted-foreground">
        Set TULIPFARM_WEBHOOK_KEY to your key before you run the example. The example never contains the key.
      </p>
      {shown &&
        (shown.key ? (
          <div className="space-y-2">
            <Label htmlFor="webhook-key">New webhook key</Label>
            <Input id="webhook-key" readOnly spellCheck={false} autoComplete="off" value={shown.key} />
            <Button
              variant="outline"
              onClick={() => void navigator.clipboard.writeText(shown.key ?? '').then(onCopied, onCopyFailed)}
            >
              Copy key
            </Button>
            <p className="text-sm text-muted-foreground">
              Copy this key into your sender now. It is shown only once and cannot be read again.
            </p>
          </div>
        ) : workflow.webhookMode === 'stripe' ? (
          <p role="note" className="text-sm">
            The Stripe signing secret was saved encrypted and is not shown again.
          </p>
        ) : (
          <p role="note" className="text-sm">
            An earlier attempt already created this key, so it cannot be shown again. Replace the key to get one you can
            copy. Replacing it again also ends the grace period of the key before it, so update senders that still use
            that key first.
          </p>
        ))}
      {workflow.webhookRotation && (
        <fieldset disabled={blocked} className="space-y-2">
          <legend className="text-sm font-medium">How senders prove they have the key</legend>
          <div className="flex flex-wrap gap-2">
            {(['github', 'stripe', 'signed', 'bearer'] as const).map(option => (
              <Button
                key={option}
                variant={mode === option ? 'secondary' : 'outline'}
                aria-pressed={mode === option}
                onClick={() => setMode(option)}
              >
                {modeLabel[option]}
              </Button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            {mode === 'bearer'
              ? 'For senders that can only set a fixed header. Anyone who sees a request can reuse the key.'
              : mode === 'github'
                ? 'Use the generated key as the GitHub webhook secret. X-Hub-Signature-256 is checked against the exact body bytes.'
                : mode === 'stripe'
                  ? 'Paste the signing secret from the Stripe endpoint. Stripe-Signature is checked against the exact body bytes and stale or replayed requests are rejected.'
                  : 'Recommended for custom senders. The key never travels with requests, and stale or replayed requests are rejected.'}
          </p>
          {mode === 'stripe' && (
            <>
              <Label htmlFor="stripe-signing-secret">Stripe endpoint signing secret</Label>
              <Input
                id="stripe-signing-secret"
                type="password"
                spellCheck={false}
                autoComplete="off"
                value={stripeSecret}
                onChange={event => setStripeSecret(event.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Find this secret in the Stripe webhook endpoint details. TulipFarm encrypts it and never shows it again.
              </p>
            </>
          )}
        </fieldset>
      )}
      <Button
        disabled={blocked || (mode === 'stripe' && !stripeSecret.trim())}
        onClick={() => onRotate(mode, mode === 'stripe' ? stripeSecret : undefined)}
      >
        {webhook.configured ? 'Replace webhook key' : 'Create webhook key'}
      </Button>
      <p className="text-sm text-muted-foreground">
        {mode === 'stripe'
          ? 'The Stripe signing secret is stored encrypted and cannot be read again.'
          : !webhook.configured
            ? 'The server creates the key and shows it once.'
            : workflow.webhookRotation
              ? 'The server creates the new key. The current key keeps working for 24 hours so you can update senders, or revoke it sooner.'
              : 'The server creates the new key. The current key stops working at once; this workspace cannot keep it during a grace period until its storage update finishes.'}{' '}
        {mode === 'bearer'
          ? 'Only a hash of a bearer key is stored.'
          : mode !== 'stripe'
            ? 'A signing key is stored encrypted.'
            : ''}
      </p>
      <p className="text-sm text-muted-foreground">
        Webhook request bodies are limited to 64 KiB, and each workflow run input is limited to 32 KiB. Rejections for
        either limit appear in the delivery log.
      </p>
      {children}
    </section>
  );
}

function formatTime(value: string) {
  return new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
