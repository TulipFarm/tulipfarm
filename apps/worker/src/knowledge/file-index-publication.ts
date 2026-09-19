import { FileKnowledgeIndexRepo } from "@tulipfarm/files";
import type { EmbeddingPort } from "@tulipfarm/knowledge";
import {
  ambientTransactionPort,
  type BlobPort,
  PgAssetOwnershipRepo,
  type Queryable,
} from "@tulipfarm/storage";
import { buildWorkerFileService } from "../files/service";
import type { FileIndexDeps } from "./file-index";
import { buildWorkerKnowledgeService } from "./service";

export function buildFileIndexPublication(options: {
  db: Queryable;
  blobs: BlobPort;
  embeddings: EmbeddingPort;
}): NonNullable<FileIndexDeps["publication"]> {
  const requests = new FileKnowledgeIndexRepo(options.db);
  return {
    requests,
    publish: (claim, input) =>
      requests.publish(claim, async (tx) => {
        const transactions = ambientTransactionPort(tx);
        const ownership = new PgAssetOwnershipRepo(transactions);
        return ownership.withLockedOwnership(claim.businessId, "file", claim.fileId, async () => {
          const files = buildWorkerFileService({
            db: tx,
            transactions,
            blobs: options.blobs,
          });
          const file = await files.read(claim.businessId, claim.fileId, claim.ownerPrincipalId);
          const readers = await files.readers(
            claim.businessId,
            claim.fileId,
            claim.ownerPrincipalId
          );
          const knowledge = buildWorkerKnowledgeService({
            db: tx,
            transactions,
            embeddings: options.embeddings,
          });
          const page = await knowledge.ingestSource({
            source: "file",
            sourceId: claim.fileId,
            title: file.filename,
            content: input.text,
            placement: { spaceId: input.spaceId, path: `${claim.fileId}.md` },
            readers,
          });
          if (!page) throw new Error("File Knowledge publication produced no Page");
          return { pageId: page._id, truncated: input.truncated };
        });
      }),
  };
}
