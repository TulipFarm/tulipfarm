export type ReadState<T> =
  | { kind: 'loading' }
  | { kind: 'ready'; data: T; refreshing: boolean; error: string | null }
  /** `busy` marks a capacity refusal (HTTP 429): the request was fine and can succeed shortly. */
  | { kind: 'error'; message: string; busy?: true }
  | { kind: 'unavailable'; status: number };

export class TableRequestError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
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
  | { kind: 'rejected'; message: string }
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
  if (rejection !== null) return { kind: 'rejected', message: rejection };
  return {
    kind: 'uncertain',
    input,
    message:
      'We could not confirm the outcome. Your input is kept here. Check status before trying the same operation again.',
  };
}
