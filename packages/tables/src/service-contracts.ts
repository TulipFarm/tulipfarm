import { z } from 'zod';

export const migrationStatusSchema = z.enum([
  'queued',
  'planning',
  'waiting_for_confirmation',
  'blocked',
  'applying',
  'applied',
  'failed',
  'rejected',
  'superseded',
]);
export class TableError extends Error {
  readonly code: string;
  readonly status: 400 | 404 | 409 | 503;
  constructor(code: string, status: 400 | 404 | 409 | 503 = 409) {
    super(code);
    this.code = code;
    this.status = status;
  }
}
