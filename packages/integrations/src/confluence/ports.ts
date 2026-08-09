/**
 * Provider-neutral Confluence Knowledge boundary.
 *
 * The API port must return the effective Confluence accounts that can read a page. If the adapter
 * cannot prove that effective ACL, it returns `undefined`; sync then emits an unverifiable source
 * and removes indexed text. Direct restrictions alone are not enough unless the adapter has already
 * resolved inherited space/ancestor permissions into this effective reader set.
 */

/** One entry from Confluence's change feed. `cursor` is the resume position after this change. */
export interface ConfluenceChange {
  readonly pageId: string;
  readonly cursor: string;
  readonly deleted?: boolean;
}

export interface ConfluencePage {
  readonly id: string;
  readonly title: string;
  readonly spaceId: string;
  readonly spaceKey: string;
  readonly version: string;
  readonly ownerAccountId: string;
  readonly updatedAt: string;
  /** Plain text extracted from the page body. */
  readonly content: string;
  readonly classification?: readonly string[];
  readonly webUrl?: string;
}

export interface ConfluencePagePermission {
  /** Atlassian account id for a Confluence user who can effectively read the page. */
  readonly accountId: string;
}

export interface ConfluenceApiPort {
  listChanged(input: { cursor?: string; pageLimit: number }): Promise<{
    readonly changes: readonly ConfluenceChange[];
    readonly nextCursor?: string;
  }>;
  /** `undefined` means deleted/unreadable. It is emitted as a deleted source. */
  getPage(pageId: string): Promise<ConfluencePage | undefined>;
  /** `undefined` means ACL unreadable. Never return `[]` to mean "unknown". */
  getPagePermissions(pageId: string): Promise<readonly ConfluencePagePermission[] | undefined>;
}

export interface ConfluenceSyncCheckpoint {
  readonly integrationId: string;
  readonly cursor?: string;
  readonly updatedAt: string;
}

/** Durable resume position. Saved only after the corresponding Confluence change committed. */
export interface ConfluenceSyncCheckpointStore {
  load(integrationId: string): Promise<ConfluenceSyncCheckpoint | undefined>;
  save(checkpoint: ConfluenceSyncCheckpoint): Promise<void>;
}

export class InMemoryConfluenceCheckpointStore implements ConfluenceSyncCheckpointStore {
  private readonly byIntegration = new Map<string, ConfluenceSyncCheckpoint>();

  async load(integrationId: string): Promise<ConfluenceSyncCheckpoint | undefined> {
    return this.byIntegration.get(integrationId);
  }

  async save(checkpoint: ConfluenceSyncCheckpoint): Promise<void> {
    this.byIntegration.set(checkpoint.integrationId, checkpoint);
  }
}
