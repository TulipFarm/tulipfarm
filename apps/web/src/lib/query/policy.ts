import { ZodError } from 'zod';
import type { ReadState } from '../../features/tables/request-state';

export const freshness = { ordinary: 60_000, catalog: 15 * 60_000, chat: 30_000 };

export function errorStatus(error: unknown): number | undefined {
  return typeof error === 'object' && error !== null && 'status' in error && typeof error.status === 'number'
    ? error.status
    : undefined;
}

export function deniedStatus(error: unknown) {
  const status = errorStatus(error);
  return status === 401 || status === 403 || status === 404 ? status : undefined;
}

export function retryRead(failures: number, error: unknown) {
  if (failures >= 2 || error instanceof ZodError) return false;
  const status = errorStatus(error);
  if (status !== undefined) return status === 408 || status === 429 || status >= 500;
  return error instanceof TypeError || (error instanceof DOMException && error.name === 'TimeoutError');
}

export function retryDelay(attempt: number, error: unknown) {
  if (errorStatus(error) === 429 && typeof error === 'object' && error !== null && 'retryAfter' in error) {
    const value = error.retryAfter;
    const seconds = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
    const milliseconds = Number.isFinite(seconds)
      ? seconds * 1000
      : typeof value === 'string'
        ? Date.parse(value) - Date.now()
        : NaN;
    if (Number.isFinite(milliseconds)) return Math.max(1000, Math.min(milliseconds, 30_000));
  }
  return Math.min(1000 * 2 ** attempt, 30_000);
}

export function readState<T>(result: { data: T | undefined; error: unknown; isFetching: boolean }): ReadState<T> {
  const status = deniedStatus(result.error);
  if (status !== undefined) return { kind: 'unavailable', status };
  const busy = errorStatus(result.error) === 429;
  const message = !result.error
    ? null
    : busy
      ? 'The service is busy. Try again in a few seconds.'
      : 'The request could not be completed. Check your connection and try again.';
  if (result.data !== undefined)
    return { kind: 'ready', data: result.data, refreshing: result.isFetching, error: message };
  return message ? { kind: 'error', message, ...(busy ? { busy } : {}) } : { kind: 'loading' };
}
