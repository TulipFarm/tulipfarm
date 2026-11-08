import { useRef, useState, type ReactNode } from 'react';
import { Button } from '@tulipfarm/sprout/button';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { useTableWrite } from './use-table-write';
import type { RecordMutation, TableApi } from './api';
import { useTableChanges } from './changes';
import { useTableReceipt } from './hooks';
import { TableRequestError } from './request-state';

type ReceiptState = { kind: 'idle' | 'checking' | 'unknown' } | { kind: 'error'; message: string };

/** `explain` turns a rejection that names fields into a message with those fields' labels, or returns undefined. */
export function useRecordMutation(
  api: TableApi,
  saved: () => void,
  explain?: (error: TableRequestError, input: RecordMutation) => string | undefined,
) {
  const changes = useTableChanges();
  const receiptRead = useTableReceipt(api);
  const write = useTableWrite(async (input: RecordMutation) => {
    try {
      const result = await api.mutate(input);
      await changes.records(input.tableId);
      return result;
    } catch (error) {
      changes.denied(error, []);
      const message = error instanceof TableRequestError ? explain?.(error, input) : undefined;
      if (error instanceof TableRequestError && message !== undefined)
        throw new TableRequestError(error.status, error.code, message, error.fieldId, error.fieldIds);
      throw error;
    }
  }, saved);
  const [receipt, setReceipt] = useState<ReceiptState>({ kind: 'idle' });
  const checking = useRef(false);
  async function check() {
    if (write.state.kind !== 'uncertain' || checking.current) return;
    checking.current = true;
    setReceipt({ kind: 'checking' });
    try {
      const result = await receiptRead(write.state.input);
      if (result.status === 'applied') {
        await changes.records(write.state.input.tableId);
        write.reset();
        setReceipt({ kind: 'idle' });
        saved();
      } else setReceipt({ kind: 'unknown' });
    } catch {
      setReceipt({
        kind: 'error',
        message: 'Could not check this row request. Check again before retrying the same request.',
      });
    } finally {
      checking.current = false;
    }
  }
  const submit = (input: RecordMutation) => {
    setReceipt({ kind: 'idle' });
    return write.submit(input);
  };
  return {
    state: write.state,
    submit,
    receipt,
    check,
    locked: write.state.kind === 'sending' || write.state.kind === 'uncertain',
  };
}

/** A rejection is definite, so it explains what to change and never offers to check status; `children` adds next steps. */
export function RecordMutationFeedback({
  mutation,
  children,
}: {
  mutation: ReturnType<typeof useRecordMutation>;
  children?: ReactNode;
}) {
  if (mutation.state.kind === 'rejected')
    return (
      <div className="space-y-3">
        <Alert variant="destructive">
          <AlertDescription>{mutation.state.message}</AlertDescription>
        </Alert>
        {children}
      </div>
    );
  if (mutation.state.kind === 'sending')
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Submitting your operation…
      </p>
    );
  if (mutation.state.kind !== 'uncertain') return null;
  return (
    <div className="space-y-3">
      <Alert variant="destructive">
        <AlertDescription>{mutation.state.message}</AlertDescription>
      </Alert>
      {mutation.receipt.kind === 'unknown' && (
        <p role="status" className="text-sm">
          No saved receipt was found. The original request may still be running. Retrying uses the same request ID and
          cannot create a second change.
        </p>
      )}
      {mutation.receipt.kind === 'error' && (
        <p role="alert" className="text-sm">
          {mutation.receipt.message}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          disabled={mutation.receipt.kind === 'checking'}
          aria-busy={mutation.receipt.kind === 'checking'}
          onClick={() => void mutation.check()}
        >
          {mutation.receipt.kind === 'checking' ? 'Checking row request…' : 'Check row request'}
        </Button>
        {mutation.receipt.kind === 'unknown' && (
          <Button
            variant="outline"
            onClick={() => {
              if (mutation.state.kind === 'uncertain') void mutation.submit(mutation.state.input);
            }}
          >
            Retry same row request
          </Button>
        )}
      </div>
    </div>
  );
}
