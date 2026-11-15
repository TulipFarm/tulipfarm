import { escapeIdentifier, type Client } from 'pg';
import type { AppFailure, AppFailureCode } from '../app.ts';

export type SqlClient = Pick<Client, 'query'>;

/** A client inside an open transaction on one workspace schema. */
export type AppTransaction = { readonly client: SqlClient; readonly schema: string };

/** Runs an action in its own transaction on the app's workspace schema. */
export type AppTransactions = <T>(action: (tx: AppTransaction) => Promise<T>) => Promise<T>;

export type AppResult<T> = ({ readonly ok: true } & T) | { readonly ok: false; readonly failure: AppFailure };

export const table = (tx: AppTransaction, name: string) => `${escapeIdentifier(tx.schema)}.${escapeIdentifier(name)}`;

export function failed(code: AppFailureCode, message: string, retryable = false) {
  return { ok: false as const, failure: { code, message, retryable } };
}

export async function rows<T>(tx: AppTransaction, sql: string, values: unknown[] = []): Promise<T[]> {
  return (await tx.client.query(sql, values)).rows as T[];
}
