import type {
  AssetAccessProjection,
  AssetOwnershipAccessService,
  AssetOwnershipRecord,
} from "@tulipfarm/authz";
import type { AssetOwnershipRepo } from "@tulipfarm/storage";
import type { KnowledgeAclEntry, KnowledgeOwnershipPort, KnowledgeSubjectKind } from "./subject";

export function knowledgeAssetId(
  kind: Extract<KnowledgeSubjectKind, "page" | "space" | "source">,
  id: string
): string {
  return `${kind}:${id}`;
}

export interface KnowledgeOwnershipWriter {
  ensureBusiness(
    businessId: string,
    kind: Extract<KnowledgeSubjectKind, "page" | "space" | "source">,
    id: string
  ): Promise<void>;
  ensurePersonal(
    businessId: string,
    kind: Extract<KnowledgeSubjectKind, "page" | "space" | "source">,
    id: string,
    principalId: string
  ): Promise<void>;
}

export class KnowledgeOwnershipProjector implements KnowledgeOwnershipPort {
  constructor(
    private readonly ownership: AssetOwnershipRepo,
    private readonly access?: AssetOwnershipAccessService
  ) {}

  async entriesFor(
    businessId: string,
    subjects: readonly {
      readonly kind: Extract<KnowledgeSubjectKind, "page" | "space" | "source">;
      readonly id: string;
    }[]
  ): Promise<ReadonlyMap<string, readonly KnowledgeAclEntry[]>> {
    const projected = new Map<string, readonly KnowledgeAclEntry[]>();
    await Promise.all(
      subjects.map(async (subject) => {
        const ownership = await this.ownership.get(
          businessId,
          "knowledge",
          knowledgeAssetId(subject.kind, subject.id)
        );
        if (ownership === undefined) return;
        const entries: KnowledgeAclEntry[] = [];
        for (const owner of ownership.owners) {
          entries.push({
            subjectKind: subject.kind,
            subjectId: subject.id,
            principal:
              owner.kind === "team"
                ? { kind: "team", id: owner.teamId }
                : { kind: owner.principalKind, id: owner.principalId },
            effect: "grant",
            capability: "read",
          });
        }

        for (const share of ownership.shares) {
          entries.push({
            subjectKind: subject.kind,
            subjectId: subject.id,
            principal: { kind: "team", id: share.teamId },
            effect: "grant",
            capability: "read",
          });
        }
        projected.set(`${subject.kind}:${subject.id}`, entries);
      })
    );
    return projected;
  }

  async accessFor(
    businessId: string,
    kind: Extract<KnowledgeSubjectKind, "page" | "space" | "source">,
    id: string,
    principalId: string
  ): Promise<AssetAccessProjection | undefined> {
    const ownership = await this.get(businessId, kind, id);
    return ownership === undefined
      ? undefined
      : this.access?.accessFor(ownership, { principalId, principalKind: "user" });
  }

  async consumeDestructiveApproval(
    businessId: string,
    kind: Extract<KnowledgeSubjectKind, "page" | "space" | "source">,
    id: string,
    operationId: string | undefined
  ): Promise<void> {
    const ownership = await this.get(businessId, kind, id);
    if (ownership !== undefined) {
      await this.access?.consumeDestructiveApproval(ownership, "delete", operationId);
    }
  }

  async ensureBusiness(
    businessId: string,
    kind: Extract<KnowledgeSubjectKind, "page" | "space" | "source">,
    id: string
  ): Promise<void> {
    await this.access?.ensureBusiness(businessId, "knowledge", knowledgeAssetId(kind, id));
  }

  async ensurePersonal(
    businessId: string,
    kind: Extract<KnowledgeSubjectKind, "page" | "space" | "source">,
    id: string,
    principalId: string
  ): Promise<void> {
    await this.access?.ensurePersonal(
      businessId,
      "knowledge",
      knowledgeAssetId(kind, id),
      principalId
    );
  }

  private async get(
    businessId: string,
    kind: Extract<KnowledgeSubjectKind, "page" | "space" | "source">,
    id: string
  ): Promise<AssetOwnershipRecord | undefined> {
    return await this.ownership.get(businessId, "knowledge", knowledgeAssetId(kind, id));
  }
}
