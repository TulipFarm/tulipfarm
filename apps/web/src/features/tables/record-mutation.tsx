import { useRef, useState } from 'react';
import { Button } from '@tulipfarm/sprout/button';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { WriteFeedback } from './feedback';
import { useTableWrite } from './use-table-write';
import type { RecordMutation, TableApi } from './api';
import { useTableChanges } from './changes';
import { useTableReceipt } from './hooks';

type ReceiptState = { kind: 'idle' | 'checking' | 'unknown' } | { kind: 'error'; message: string };

export function useRecordMutation(api: TableApi, saved: () => void) {
  const changes = useTableChanges();
  const receiptRead = useTableReceipt(api);
  const write = useTableWrite(async (input: RecordMutation) => {
    try {
      const result = await api.mutate(input);
      await changes.records(input.tableId);
      return result;
    } catch (error) {
      changes.denied(error, []);
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

export function RecordMutationFeedback({
  mutation,
  refresh,
}: {
  mutation: ReturnType<typeof useRecordMutation>;
  refresh: () => Promise<void>;
}) {
  if (mutation.state.kind !== 'uncertain')
    return <WriteFeedback state={mutation.state} checkStatus={() => void refresh()} />;
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
