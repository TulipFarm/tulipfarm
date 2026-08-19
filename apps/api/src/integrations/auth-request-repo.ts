/** The one-use server-side auth request row: PKCE verifier custody between authorize and callback. */

import type { Queryable } from "../db";

export interface IntegrationAuthRequestDoc {
  state: string;
  integrationSlug: string;
  stepIndex: number;
  codeVerifier: string | null;
  callbackUrl?: string | null;
  webUrl?: string | null;
  apiUrl?: string | null;
  createdAt: Date;
  expiresAt: Date;
  consumedAt: Date | null;
  /** Null means business-wide; otherwise the callback must seal a principal-owned credential. */
  principal: { readonly kind: string; readonly id: string } | null;
}

export interface IntegrationAuthRequestRepo {
  create(request: IntegrationAuthRequestDoc): Promise<void>;
  consume(state: string): Promise<IntegrationAuthRequestDoc | null>;
}

export const DEFAULT_AUTH_REQUEST_TTL_SECONDS = 600;

function rowToRequest(row: Record<string, unknown>): IntegrationAuthRequestDoc {
  const kind = (row.principal_kind as string | null) ?? null;
  const id = (row.principal_id as string | null) ?? null;
  return {
    state: row.state as string,
    integrationSlug: row.integration_slug as string,
    stepIndex: row.step_index as number,
    codeVerifier: (row.code_verifier as string | null) ?? null,
    callbackUrl: (row.callback_url as string | null) ?? null,
    webUrl: (row.web_url as string | null) ?? null,
    apiUrl: (row.api_url as string | null) ?? null,
    createdAt: row.created_at as Date,
    expiresAt: row.expires_at as Date,
    consumedAt: (row.consumed_at as Date | null) ?? null,
    // Both or neither: half a principal would attribute credentials to the wrong subject.
    principal: kind !== null && id !== null ? { kind, id } : null,
  };
}

export class PgIntegrationAuthRequestRepo implements IntegrationAuthRequestRepo {
  constructor(private readonly q: Queryable) {}

  async create(request: IntegrationAuthRequestDoc): Promise<void> {
    await this.q.query(
      `INSERT INTO integration_auth_requests
         (state, integration_slug, step_index, code_verifier, created_at, expires_at, consumed_at,
          principal_kind, principal_id, callback_url, web_url, api_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        request.state,
        request.integrationSlug,
        request.stepIndex,
        request.codeVerifier,
        request.createdAt,
        request.expiresAt,
        request.consumedAt,
        request.principal?.kind ?? null,
        request.principal?.id ?? null,
        request.callbackUrl ?? null,
        request.webUrl ?? null,
        request.apiUrl ?? null,
      ]
    );
  }

  async consume(state: string): Promise<IntegrationAuthRequestDoc | null> {
    const { rows } = await this.q.query(
      `UPDATE integration_auth_requests SET consumed_at = now()
       WHERE state = $1 AND consumed_at IS NULL AND expires_at > now()
       RETURNING *`,
      [state]
    );
    return rows.length > 0 ? rowToRequest(rows[0]) : null;
  }
}
