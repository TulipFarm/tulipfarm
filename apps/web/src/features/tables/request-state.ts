export type ReadState<T> =
  | { kind: 'loading' }
  | { kind: 'ready'; data: T; refreshing: boolean; error: string | null }
  /** `busy` marks a capacity refusal (HTTP 429): the request was fine and can succeed shortly. */
  /**
   * `updating` marks a workspace still taking a release's update: the read succeeds by itself once it finishes.
   * `retrying` while automatic retries continue, `stopped` once they have run out.
   */
  | { kind: 'error'; message: string; busy?: true; updating?: 'retrying' | 'stopped' }
  | { kind: 'unavailable'; status: number };

export class TableRequestError extends Error {
  readonly status: number;
  readonly code: string;
  /** The field a rejected write names, when the server identifies one. */
  readonly fieldId: string | undefined;
  /** The unique key's fields when a write collides with another row. */
  readonly fieldIds: string[] | undefined;
  constructor(status: number, code: string, message: string, fieldId?: string, fieldIds?: string[]) {
    super(message);
    this.status = status;
    this.code = code;
    this.fieldId = fieldId;
    this.fieldIds = fieldIds;
  }
}

export function beginRead<T>(state: ReadState<T>): ReadState<T> {
  return state.kind === 'ready' ? { ...state, refreshing: true, error: null } : { kind: 'loading' };
}

export function failedRead<T>(state: ReadState<T>, error: unknown): ReadState<T> {
  if (error instanceof TableRequestError && [401, 403, 404].includes(error.status)) {
    return { kind: 'unavailable', status: error.status };
  }
  const message =
    error instanceof TableRequestError
      ? error.message
      : 'The request could not be completed. Check your connection and try again.';
  return state.kind === 'ready' ? { ...state, refreshing: false, error: message } : { kind: 'error', message };
}

export type WriteState<T> =
  | { kind: 'idle' }
  | { kind: 'sending'; input: T }
  | { kind: 'uncertain'; input: T; message: string }
  /** `conflict` names a unique key another row already uses, with the refused input, so the screen can point to that row. */
  | { kind: 'rejected'; message: string; conflict?: { fieldIds: string[]; input: T } }
  | { kind: 'accepted' };

export function confirmedRejection(error: unknown): string | null {
  return error instanceof TableRequestError &&
    error.status >= 400 &&
    error.status < 500 &&
    ![408, 429].includes(error.status)
    ? error.message
    : null;
}

export function failedWrite<T>(input: T, error: unknown): WriteState<T> {
  const rejection = confirmedRejection(error);
  if (rejection !== null)
    return error instanceof TableRequestError && error.code === 'duplicate-key' && error.fieldIds?.length
      ? { kind: 'rejected', message: rejection, conflict: { fieldIds: error.fieldIds, input } }
      : { kind: 'rejected', message: rejection };
  return {
    kind: 'uncertain',
    input,
    message:
      'We could not confirm the outcome. Your input is kept here. Check status before trying the same operation again.',
  };
}
