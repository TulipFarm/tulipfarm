/** Notion readers must be proven explicitly; `undefined` means unverifiable, not private. */

export interface NotionChange {
  readonly pageId: string;
  readonly cursor: string;
  readonly deleted?: boolean;
}

export interface NotionPage {
  readonly id: string;
  readonly title: string;
  readonly version: string;
  readonly ownerExternalId: string;
  readonly lastEditedTime: string;
  readonly content: string;
  readonly classification?: readonly string[];
  readonly webUrl?: string;
}

export interface NotionPagePermission {
  readonly userId: string;
}

export interface NotionApiPort {
  listChanged(input: { cursor?: string; pageLimit: number }): Promise<{
    readonly changes: readonly NotionChange[];
    readonly nextCursor?: string;
  }>;
  getPage(pageId: string): Promise<NotionPage | undefined>;
  /** `undefined` means the page ACL cannot be proven and retrieval must fail closed. */
  getPagePermissions(pageId: string): Promise<readonly NotionPagePermission[] | undefined>;
}

export interface NotionSyncCheckpoint {
  readonly integrationId: string;
  readonly cursor?: string;
  readonly updatedAt: string;
}

export interface NotionSyncCheckpointStore {
  load(integrationId: string): Promise<NotionSyncCheckpoint | undefined>;
  save(checkpoint: NotionSyncCheckpoint): Promise<void>;
}

export class InMemoryNotionCheckpointStore implements NotionSyncCheckpointStore {
  private readonly byIntegration = new Map<string, NotionSyncCheckpoint>();

  async load(integrationId: string): Promise<NotionSyncCheckpoint | undefined> {
    return this.byIntegration.get(integrationId);
  }

  async save(checkpoint: NotionSyncCheckpoint): Promise<void> {
    this.byIntegration.set(checkpoint.integrationId, checkpoint);
  }
}
