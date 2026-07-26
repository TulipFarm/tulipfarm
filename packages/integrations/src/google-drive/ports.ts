/**
 * Provider-neutral Google Drive/Docs boundary (SPEC §15: concrete transports live in
 * `apps/integration-worker`, never here).
 *
 * The two `undefined` returns are load-bearing, not conveniences: `getPermissions` returning
 * `undefined` means "the ACL could not be established", which the sync turns into an
 * `unverifiable` source that denies, and `getFile` returning `undefined` means the file is gone,
 * which becomes a deletion. Neither is ever treated as "no restrictions".
 */

/** One entry from Drive's change feed. `cursor` is the resume position *after* this change. */
export interface DriveChange {
  readonly fileId: string;
  readonly cursor: string;
  readonly removed?: boolean;
}

export interface DriveFile {
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  /** Drive's monotonically increasing file version; the Knowledge source revision. */
  readonly version: string;
  readonly ownerExternalId: string;
  /** Provider-supplied content digest (e.g. md5Checksum/version digest), not derived here. */
  readonly contentHash: string;
  readonly modifiedTime: string;
  readonly trashed: boolean;
  /** Classification labels the workspace applied; absent falls back to the configured default. */
  readonly classification?: readonly string[];
  /** True for scanned/image content, which needs OCR before it can be indexed. */
  readonly requiresOcr?: boolean;
}

export interface DrivePermission {
  readonly type: "user" | "group" | "domain" | "anyone";
  /** Email, domain, or `anyone`. Resolved through the identity map; unmapped subjects are dropped. */
  readonly externalSubject: string;
  readonly role: string;
}

export interface DriveApiPort {
  listChanges(input: { cursor?: string; pageLimit: number }): Promise<{
    readonly changes: readonly DriveChange[];
    readonly nextCursor?: string;
  }>;
  getFile(fileId: string): Promise<DriveFile | undefined>;
  /** `undefined` = permissions unreadable. Never return `[]` to mean "unknown". */
  getPermissions(fileId: string): Promise<readonly DrivePermission[] | undefined>;
  exportText(
    fileId: string
  ): Promise<{ readonly text: string; readonly mimeType: string } | undefined>;
}

export interface DriveSyncCheckpoint {
  readonly integrationId: string;
  readonly cursor?: string;
  readonly updatedAt: string;
}

/**
 * Durable resume position. The sync advances it only after a change has been fully committed to
 * the Knowledge sink, so a crash re-processes the failed change instead of skipping it.
 */
export interface DriveSyncCheckpointStore {
  load(integrationId: string): Promise<DriveSyncCheckpoint | undefined>;
  save(checkpoint: DriveSyncCheckpoint): Promise<void>;
}

export class InMemoryDriveCheckpointStore implements DriveSyncCheckpointStore {
  private readonly byIntegration = new Map<string, DriveSyncCheckpoint>();

  async load(integrationId: string): Promise<DriveSyncCheckpoint | undefined> {
    return this.byIntegration.get(integrationId);
  }

  async save(checkpoint: DriveSyncCheckpoint): Promise<void> {
    this.byIntegration.set(checkpoint.integrationId, checkpoint);
  }
}
