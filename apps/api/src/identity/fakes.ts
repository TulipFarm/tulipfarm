/**
 * In-memory identity repositories for tests. They live outside `*.test.ts` so several test files
 * (and `routes.test.ts`) can share one fake per port.
 */
import type { ApiClientDoc, ApiClientRepo, ApiClientStatus } from "./api-clients";
import type {
  ExternalIdentityMappingDoc,
  ExternalIdentityRepo,
  ExternalLinkTokenDoc,
} from "./external-links";
import type { OidcAuthRequestDoc, OidcAuthRequestRepo } from "./oidc";

export class MemoryApiClientRepo implements ApiClientRepo {
  clients: ApiClientDoc[] = [];

  async create(client: ApiClientDoc): Promise<void> {
    this.clients.push(client);
  }
  async findByClientId(clientId: string): Promise<ApiClientDoc | null> {
    return this.clients.find((c) => c.clientId === clientId) ?? null;
  }
  async findById(id: string): Promise<ApiClientDoc | null> {
    return this.clients.find((c) => c._id === id) ?? null;
  }
  async findAll(): Promise<ApiClientDoc[]> {
    return [...this.clients];
  }
  async updateSecret(id: string, secretHash: string, rotatedAt: Date): Promise<void> {
    const client = this.clients.find((c) => c._id === id);
    if (client) {
      client.secretHash = secretHash;
      client.rotatedAt = rotatedAt;
    }
  }
  async updateStatus(id: string, status: ApiClientStatus): Promise<void> {
    const client = this.clients.find((c) => c._id === id);
    if (client) client.status = status;
  }
}

export class MemoryExternalIdentityRepo implements ExternalIdentityRepo {
  mappings: ExternalIdentityMappingDoc[] = [];
  tokens: ExternalLinkTokenDoc[] = [];

  async findMapping(
    provider: string,
    externalSubject: string
  ): Promise<ExternalIdentityMappingDoc | null> {
    return (
      this.mappings.find((m) => m.provider === provider && m.externalSubject === externalSubject) ??
      null
    );
  }
  async listMappingsForUser(userId: string): Promise<ExternalIdentityMappingDoc[]> {
    return this.mappings.filter((m) => m.userId === userId);
  }
  async upsertMapping(mapping: ExternalIdentityMappingDoc): Promise<void> {
    const existing = await this.findMapping(mapping.provider, mapping.externalSubject);
    if (existing) {
      Object.assign(existing, mapping);
      return;
    }
    this.mappings.push({ ...mapping });
  }
  async deleteMapping(provider: string, externalSubject: string): Promise<void> {
    this.mappings = this.mappings.filter(
      (m) => !(m.provider === provider && m.externalSubject === externalSubject)
    );
  }
  async createLinkToken(token: ExternalLinkTokenDoc): Promise<void> {
    this.tokens.push({ ...token });
  }
  async consumeLinkToken(tokenHash: string): Promise<ExternalLinkTokenDoc | null> {
    const token = this.tokens.find(
      (t) => t.tokenHash === tokenHash && t.consumedAt === null && t.expiresAt > new Date()
    );
    if (!token) return null;
    token.consumedAt = new Date();
    return { ...token };
  }
}

export class MemoryOidcRequestRepo implements OidcAuthRequestRepo {
  requests: OidcAuthRequestDoc[] = [];

  async create(request: OidcAuthRequestDoc): Promise<void> {
    this.requests.push({ ...request });
  }

  async consume(state: string): Promise<OidcAuthRequestDoc | null> {
    const request = this.requests.find(
      (r) => r.state === state && r.consumedAt === null && r.expiresAt > new Date()
    );
    if (!request) return null;
    request.consumedAt = new Date();
    return { ...request };
  }
}
