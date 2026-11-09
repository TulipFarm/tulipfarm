import { useState, type ReactNode } from 'react';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { Button } from '@tulipfarm/sprout/button';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from '@tulipfarm/sprout/alert-dialog';

export type Confirmation = {
  title: string;
  description: ReactNode;
  action: string;
  destructive?: boolean;
  /** Resolves to null when done, or to the reason it failed; the dialog stays open on failure. */
  run: () => Promise<string | null>;
  body?: ReactNode;
};

/** One controlled confirmation for menu actions, so a menu item can open it after the menu closes. */
export function useConfirmation() {
  const [current, setCurrent] = useState<Confirmation | null>(null);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const element = (
    <AlertDialog
      open={current !== null}
      onOpenChange={open => {
        if (!open && !pending) setCurrent(null);
      }}
    >
      <AlertDialogContent>
        <AlertDialogTitle>{current?.title}</AlertDialogTitle>
        <AlertDialogDescription>{current?.description}</AlertDialogDescription>
        {current?.body}
        {failure && (
          <Alert variant="destructive">
            <AlertDescription>{failure}</AlertDescription>
          </Alert>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <Button
            variant={current?.destructive === false ? 'default' : 'destructive'}
            disabled={pending}
            aria-busy={pending}
            onClick={async () => {
              if (!current || pending) return;
              setPending(true);
              setFailure(null);
              const reason = await current.run();
              setPending(false);
              if (reason === null) setCurrent(null);
              else setFailure(reason);
            }}
          >
            {current?.action}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
  return {
    element,
    open: (confirmation: Confirmation) => {
      setFailure(null);
      setCurrent(confirmation);
    },
  };
}
