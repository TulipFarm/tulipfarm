import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { hashToken } from "../auth/api-tokens";
import type { Queryable } from "../db";

/**
 * API clients are service identities (SPEC §12): separate owner, own credential, rotation,
 * expiry, and disable. They are deliberately *not* user API tokens — a client authenticates as
 * itself and never inherits a user's session, so a leaked client secret cannot act as a person.
 *
 * Wire format: `Authorization: Bearer tfc_<clientId>.<secret>`. Only the secret's hash is stored.
 */
export const API_CLIENT_TOKEN_PREFIX = "tfc_";

export type ApiClientStatus = "active" | "disabled";

export interface ApiClientDoc {
  _id: string;
  clientId: string;
  name: string;
  secretHash: string;
  /** `null` means the deployment owns it, not a person — see migration 19. */
  ownerUserId: string | null;
  status: ApiClientStatus;
  expiresAt: Date | null;
  createdAt: Date;
  rotatedAt: Date | null;
}

export interface PublicApiClient {
  id: string;
  clientId: string;
  name: string;
  ownerUserId: string | null;
  status: ApiClientStatus;
  expiresAt: string | null;
  createdAt: string;
  rotatedAt: string | null;
}

/** Never exposes `secretHash` — the secret is returned exactly once, at mint/rotate time. */
export function toPublicApiClient(client: ApiClientDoc): PublicApiClient {
  return {
    id: client._id,
    clientId: client.clientId,
    name: client.name,
    ownerUserId: client.ownerUserId,
    status: client.status,
    expiresAt: client.expiresAt ? client.expiresAt.toISOString() : null,
    createdAt: client.createdAt.toISOString(),
    rotatedAt: client.rotatedAt ? client.rotatedAt.toISOString() : null,
  };
}

export interface ApiClientRepo {
  create(client: ApiClientDoc): Promise<void>;
  findByClientId(clientId: string): Promise<ApiClientDoc | null>;
  findById(id: string): Promise<ApiClientDoc | null>;
  findAll(): Promise<ApiClientDoc[]>;
  updateSecret(id: string, secretHash: string, rotatedAt: Date): Promise<void>;
  updateStatus(id: string, status: ApiClientStatus): Promise<void>;
}

function rowToClient(row: Record<string, unknown>): ApiClientDoc {
  return {
    _id: row.id as string,
    clientId: row.client_id as string,
    name: row.name as string,
    secretHash: row.secret_hash as string,
    ownerUserId: (row.owner_user_id as string | null) ?? null,
    status: row.status as ApiClientStatus,
    expiresAt: (row.expires_at as Date | null) ?? null,
    createdAt: row.created_at as Date,
    rotatedAt: (row.rotated_at as Date | null) ?? null,
  };
}

export class PgApiClientRepo implements ApiClientRepo {
  constructor(private readonly q: Queryable) {}

  async create(client: ApiClientDoc): Promise<void> {
    await this.q.query(
      `INSERT INTO api_clients (id, client_id, name, secret_hash, owner_user_id, status, expires_at, created_at, rotated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        client._id,
        client.clientId,
        client.name,
        client.secretHash,
        client.ownerUserId,
        client.status,
        client.expiresAt,
        client.createdAt,
        client.rotatedAt,
      ]
    );
  }

  async findByClientId(clientId: string): Promise<ApiClientDoc | null> {
    const { rows } = await this.q.query("SELECT * FROM api_clients WHERE client_id = $1", [
      clientId,
    ]);
    return rows.length > 0 ? rowToClient(rows[0]) : null;
  }

  async findById(id: string): Promise<ApiClientDoc | null> {
    const { rows } = await this.q.query("SELECT * FROM api_clients WHERE id = $1", [id]);
    return rows.length > 0 ? rowToClient(rows[0]) : null;
  }

  async findAll(): Promise<ApiClientDoc[]> {
    const { rows } = await this.q.query("SELECT * FROM api_clients ORDER BY created_at, id");
    return rows.map(rowToClient);
  }

  async updateSecret(id: string, secretHash: string, rotatedAt: Date): Promise<void> {
    await this.q.query("UPDATE api_clients SET secret_hash = $2, rotated_at = $3 WHERE id = $1", [
      id,
      secretHash,
      rotatedAt,
    ]);
  }

  async updateStatus(id: string, status: ApiClientStatus): Promise<void> {
    await this.q.query("UPDATE api_clients SET status = $2 WHERE id = $1", [id, status]);
  }
}

function newSecret(): string {
  return randomBytes(32).toString("base64url");
}

function newClientId(): string {
  return randomBytes(9).toString("base64url");
}

export function formatApiClientCredential(clientId: string, secret: string): string {
  return `${API_CLIENT_TOKEN_PREFIX}${clientId}.${secret}`;
}

/** Splits `tfc_<clientId>.<secret>`; returns null for anything that is not that shape. */
export function parseApiClientCredential(raw: string): { clientId: string; secret: string } | null {
  if (!raw.startsWith(API_CLIENT_TOKEN_PREFIX)) return null;
  const body = raw.slice(API_CLIENT_TOKEN_PREFIX.length);
  const separator = body.indexOf(".");
  if (separator <= 0 || separator === body.length - 1) return null;
  return { clientId: body.slice(0, separator), secret: body.slice(separator + 1) };
}

function hashesMatch(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export async function createApiClient(
  repo: ApiClientRepo,
  input: { name: string; ownerUserId: string | null; expiresAt?: Date | null }
): Promise<{ doc: ApiClientDoc; secret: string }> {
  const secret = newSecret();
  const doc: ApiClientDoc = {
    _id: randomUUID(),
    clientId: newClientId(),
    name: input.name,
    secretHash: hashToken(secret),
    ownerUserId: input.ownerUserId,
    status: "active",
    expiresAt: input.expiresAt ?? null,
    createdAt: new Date(),
    rotatedAt: null,
  };
  await repo.create(doc);
  return { doc, secret };
}

/** Rotates the client secret in place; the previous secret stops working immediately. */
export async function rotateApiClientSecret(
  repo: ApiClientRepo,
  id: string
): Promise<{ secret: string; credential: string } | null> {
  const client = await repo.findById(id);
  if (!client) return null;
  const secret = newSecret();
  await repo.updateSecret(id, hashToken(secret), new Date());
  return { secret, credential: formatApiClientCredential(client.clientId, secret) };
}

/**
 * Resolves a raw credential to its client. Returns null for unknown client ids and for wrong
 * secrets alike — the caller cannot tell which, so this is not a client-id oracle. Status and
 * expiry are enforced by the caller through `assertApiClientAuthenticatable`.
 */
export async function authenticateApiClient(
  repo: ApiClientRepo,
  raw: string
): Promise<ApiClientDoc | null> {
  const parsed = parseApiClientCredential(raw);
  if (!parsed) return null;
  const client = await repo.findByClientId(parsed.clientId);
  if (!client) return null;
  return hashesMatch(client.secretHash, hashToken(parsed.secret)) ? client : null;
}
