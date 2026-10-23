import { useState } from 'react';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from '@tulipfarm/sprout/alert-dialog';
import { Button } from '@tulipfarm/sprout/button';
import type { Variant } from '@tulipfarm/social/contracts';
import { temporaryBlockedReasons } from '@tulipfarm/social/contracts';
import { socialError } from '@/lib/social';
import { blockedReasons } from './presentation';

export type BlockedVariantActions = {
  resume: (variantId: string) => Promise<Variant>;
  cancel: (variantId: string) => Promise<Variant>;
};

/**
 * Resume or cancel a blocked variant (PRODUCT 25). Only someone holding `publish` on the channel may act; anyone
 * else is told who can. Cancelling asks first, and every outcome is announced, including a resume that blocks again.
 */
export function BlockedVariant({
  variant,
  channel,
  canPublish,
  actions,
}: {
  variant: Variant;
  channel: string;
  canPublish: boolean;
  actions: BlockedVariantActions;
}) {
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async (action: () => Promise<string>) => {
    setBusy(true);
    setError(null);
    setOutcome(null);
    try {
      setOutcome(await action());
    } catch (failure) {
      setError(socialError(failure));
    } finally {
      setBusy(false);
    }
  };
  const resume = () =>
    run(async () => {
      const result = await actions.resume(variant.id);
      if (result.state !== 'blocked') return 'Resumed. It publishes shortly.';
      return `Still blocked. ${result.blockedReason ? blockedReasons[result.blockedReason] : ''}`.trim();
    });
  const cancel = () =>
    run(async () => {
      setConfirming(false);
      await actions.cancel(variant.id);
      return 'Variant cancelled. It will not publish.';
    });
  const temporary = variant.blockedReason !== null && temporaryBlockedReasons.has(variant.blockedReason);
  return (
    <>
      {variant.state === 'blocked' && !canPublish && (
        <p className="text-sm text-muted-foreground">
          Only someone with the publish grant on this channel can resume or cancel it. Ask a channel manager.
        </p>
      )}
      {variant.state === 'blocked' && canPublish && (
        <div className="flex flex-wrap gap-2">
          {!temporary && (
            <Button
              variant="outline"
              disabled={busy}
              aria-busy={busy}
              aria-label={`Resume variant on ${channel}`}
              onClick={() => void resume()}
            >
              Resume
            </Button>
          )}
          <Button
            variant="ghost"
            disabled={busy}
            aria-label={`Cancel variant on ${channel}`}
            onClick={() => setConfirming(true)}
          >
            Cancel variant
          </Button>
        </div>
      )}
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogTitle>Cancel the variant on {channel}?</AlertDialogTitle>
          <AlertDialogDescription>
            It will not publish to {channel}. Other channels in this post are not affected. You cannot undo this.
          </AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Keep variant</AlertDialogCancel>
            <Button variant="destructive" disabled={busy} onClick={() => void cancel()}>
              Cancel variant
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <p role="status" className="text-sm empty:hidden">
        {outcome}
      </p>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </>
  );
}
