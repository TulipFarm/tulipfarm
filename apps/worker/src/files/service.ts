import { randomUUID } from "node:crypto";
import { FileService, PgFileRepo } from "@tulipfarm/files";
import {
  type BlobPort,
  PgGroupRepo,
  PgRoleRepo,
  type Queryable,
  type TransactionPort,
} from "@tulipfarm/storage";
import { collectHeldRoleIds } from "@tulipfarm/tool-host";

export interface WorkerFileServiceOptions {
  readonly db: Queryable;
  readonly transactions: TransactionPort;
  readonly blobs: BlobPort;
  readonly newId?: () => string;
}

/**
 * The Worker's `FileService`, shared by the hosted File Tools and by Knowledge indexing.
 *
 * Composed without `imagePolicy`, the one dependency that would need a live Soul. Neither caller
 * can reach it: `imagePolicy` is read by `upload`, and this process only ever reads, generates or
 * indexes. One builder rather than two because `rolesOf` is the answer to "who may read this
 * File", and a second implementation of that is how a File stays readable to somebody a Role no
 * longer contains.
 */
export function buildWorkerFileService(options: WorkerFileServiceOptions): FileService {
  return new FileService({
    repo: new PgFileRepo(options.db),
    blobs: options.blobs,
    newId: options.newId ?? randomUUID,
    rolesOf: (businessId, principalId) =>
      collectHeldRoleIds(
        {
          roles: new PgRoleRepo(options.transactions),
          groups: new PgGroupRepo(options.transactions),
        },
        businessId,
        principalId,
        new Date()
      ),
  });
}
