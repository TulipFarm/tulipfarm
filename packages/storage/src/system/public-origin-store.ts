import type { Queryable } from "../ports";

export interface StoredPublicOrigins {
  readonly webOrigin: string;
  readonly apiOrigin: string | null;
}

interface PublicOriginRow {
  web_origin: string;
  api_origin: string | null;
}

export const PUBLIC_ORIGIN_STORAGE_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS deployment_public_origins (
    business_id text PRIMARY KEY,
    web_origin  text NOT NULL CHECK (length(web_origin) > 0),
    api_origin  text CHECK (api_origin IS NULL OR length(api_origin) > 0),
    updated_at  timestamptz NOT NULL DEFAULT now()
  )`,
];

/** Durable deployment addresses, separate from portable Soul configuration. */
export class PublicOriginStore {
  constructor(private readonly queryable: Queryable) {}

  async get(businessId: string): Promise<StoredPublicOrigins | null> {
    const result = await this.queryable.query<PublicOriginRow>(
      `SELECT web_origin, api_origin
         FROM deployment_public_origins
        WHERE business_id = $1`,
      [businessId]
    );
    const row = result.rows[0];
    return row ? { webOrigin: row.web_origin, apiOrigin: row.api_origin } : null;
  }

  async put(businessId: string, origins: StoredPublicOrigins): Promise<void> {
    await this.queryable.query(
      `INSERT INTO deployment_public_origins (business_id, web_origin, api_origin, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (business_id) DO UPDATE
         SET web_origin = EXCLUDED.web_origin,
             api_origin = EXCLUDED.api_origin,
             updated_at = now()`,
      [businessId, origins.webOrigin, origins.apiOrigin]
    );
  }

  async delete(businessId: string): Promise<void> {
    await this.queryable.query("DELETE FROM deployment_public_origins WHERE business_id = $1", [
      businessId,
    ]);
  }
}
