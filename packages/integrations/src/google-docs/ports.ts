/** Drive-backed ACLs must include inherited permissions; `anyone` is not a grant. */

export interface GoogleDocsChange {
  readonly documentId: string;
  readonly cursor: string;
  readonly removed?: boolean;
}

export interface GoogleDocsDocument {
  readonly id: string;
  readonly title: string;
  readonly version: string;
  readonly ownerExternalId: string;
  readonly modifiedTime: string;
  readonly contentHash: string;
  readonly text: string;
  readonly trashed: boolean;
  readonly classification?: readonly string[];
}

export interface GoogleDocsPermission {
  readonly type: "user" | "group" | "domain" | "anyone";
  readonly externalSubject: string;
  readonly role: string;
}

export interface GoogleDocsApiPort {
  listChanged(input: { cursor?: string; pageLimit: number }): Promise<{
    readonly changes: readonly GoogleDocsChange[];
    readonly nextCursor?: string;
  }>;
  getDocument(documentId: string): Promise<GoogleDocsDocument | undefined>;
  /** `undefined` = permissions unreadable. Never return `[]` to mean unknown. */
  getDocumentPermissions(documentId: string): Promise<readonly GoogleDocsPermission[] | undefined>;
}

export interface GoogleDocsSyncCheckpoint {
  readonly integrationId: string;
  readonly cursor?: string;
  readonly updatedAt: string;
}

export interface GoogleDocsSyncCheckpointStore {
  load(integrationId: string): Promise<GoogleDocsSyncCheckpoint | undefined>;
  save(checkpoint: GoogleDocsSyncCheckpoint): Promise<void>;
}

export class InMemoryGoogleDocsCheckpointStore implements GoogleDocsSyncCheckpointStore {
  private readonly byIntegration = new Map<string, GoogleDocsSyncCheckpoint>();

  async load(integrationId: string): Promise<GoogleDocsSyncCheckpoint | undefined> {
    return this.byIntegration.get(integrationId);
  }

  async save(checkpoint: GoogleDocsSyncCheckpoint): Promise<void> {
    this.byIntegration.set(checkpoint.integrationId, checkpoint);
  }
}
