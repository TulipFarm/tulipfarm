import { randomUUID } from "node:crypto";
import type { OimCompanionFile, OimManifest } from "@tulipfarm/schema";
import type {
  OimAuthoredDraftReleaseSourceProvenance,
  PersistedInstalledOimReleaseProvenance,
} from "@tulipfarm/storage";
import type { OimReviewedCommunityDraft, OimReviewedCommunityDraftPort } from "../releases";

export interface IntegrationDraftFile {
  readonly path: string;
  readonly role: OimCompanionFile["role"];
  readonly content: string;
}

export interface IntegrationDraftSource extends OimAuthoredDraftReleaseSourceProvenance {
  readonly runId: string;
}

export type InstalledIntegrationGeneration = PersistedInstalledOimReleaseProvenance;

export type IntegrationDraftReplacement =
  | { readonly kind: "none" }
  | {
      readonly kind: "generation";
      readonly generation: InstalledIntegrationGeneration;
    };

export interface IntegrationDraft {
  readonly slug: string;
  readonly manifest: OimManifest;
  readonly manifestText: string;
  readonly files: readonly IntegrationDraftFile[];
  readonly replacement: IntegrationDraftReplacement;
  readonly replacementIssues: readonly string[];
  readonly provenance: IntegrationDraftSource;
}

export type ClaimedIntegrationDraft = OimReviewedCommunityDraft;

export interface PutIntegrationDraft {
  readonly slug: string;
  readonly manifest: OimManifest;
  readonly manifestText: string;
  readonly files: readonly IntegrationDraftFile[];
  readonly businessId: string;
  readonly principal: { readonly kind: string; readonly id: string };
  readonly runId: string;
  readonly toolCallId?: string;
  readonly replacement: IntegrationDraftReplacement;
  readonly replacementIssues: readonly string[];
}

export interface IntegrationDraftStoreOptions {
  readonly now?: () => number;
  readonly reviewId?: () => string;
  readonly ttlMs?: number;
  readonly maxDrafts?: number;
}

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_DRAFTS = 32;

function draftKey(
  digest: string,
  owner: {
    readonly businessId: string;
    readonly principal: { readonly kind: string; readonly id: string };
    readonly runId: string;
  }
): string {
  return JSON.stringify([
    owner.businessId,
    owner.principal.kind,
    owner.principal.id,
    owner.runId,
    digest,
  ]);
}

export class IntegrationDraftStore implements OimReviewedCommunityDraftPort {
  private readonly drafts = new Map<
    string,
    { readonly draft: IntegrationDraft; readonly expiresAt: number; claimExpiresAt?: number }
  >();
  private readonly now: () => number;
  private readonly reviewId: () => string;
  private readonly ttlMs: number;
  private readonly maxDrafts: number;

  constructor(options: IntegrationDraftStoreOptions = {}) {
    this.now = options.now ?? Date.now;
    this.reviewId = options.reviewId ?? randomUUID;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.maxDrafts = options.maxDrafts ?? DEFAULT_MAX_DRAFTS;
  }

  put(digest: string, input: PutIntegrationDraft): IntegrationDraft {
    const now = this.now();
    const key = draftKey(digest, input);
    this.removeExpired(now);
    const existing = this.drafts.get(key);
    if (existing !== undefined) return structuredClone(existing.draft);
    this.makeRoom();

    const reviewId = this.reviewId();
    const reviewedAt = new Date(now).toISOString();
    const draft = structuredClone({
      slug: input.slug,
      manifest: input.manifest,
      manifestText: input.manifestText,
      files: input.files,
      replacement: input.replacement,
      replacementIssues: input.replacementIssues,
      provenance: {
        kind: "authored_draft" as const,
        reviewId,
        reviewedAt,
        reviewedBy: {
          businessId: input.businessId,
          principal: input.principal,
        },
        runId: input.runId,
        ...(input.toolCallId === undefined ? {} : { toolCallId: input.toolCallId }),
      },
    });
    this.drafts.set(key, { draft, expiresAt: now + this.ttlMs });
    return structuredClone(draft);
  }

  get(
    digest: string,
    owner: {
      readonly businessId: string;
      readonly principal: { readonly kind: string; readonly id: string };
      readonly runId: string;
    }
  ): IntegrationDraft | undefined {
    const now = this.now();
    this.removeExpired(now);
    const entry = this.drafts.get(draftKey(digest, owner));
    return entry === undefined ? undefined : structuredClone(entry.draft);
  }

  async claim(input: {
    readonly businessId: string;
    readonly approvedPackageDigest: string;
    readonly principal: { readonly kind: string; readonly id: string };
    readonly runId: string;
  }): Promise<ClaimedIntegrationDraft | null> {
    const now = this.now();
    this.removeExpired(now);
    const entry = this.drafts.get(draftKey(input.approvedPackageDigest, input));
    if (entry === undefined) return null;
    entry.claimExpiresAt = now + this.ttlMs;
    const draft = structuredClone(entry.draft);
    return {
      slug: draft.slug,
      package: {
        manifest: draft.manifest,
        files: new Map(draft.files.map((file) => [file.path, file.content])),
      },
      source: draft.provenance,
      ...(draft.replacement.kind === "none" ? {} : { replace: draft.replacement.generation }),
      replacementIssues: draft.replacementIssues,
    };
  }

  async acknowledge(input: {
    readonly businessId: string;
    readonly approvedPackageDigest: string;
    readonly principal: { readonly kind: string; readonly id: string };
    readonly runId: string;
    readonly reviewId: string;
    readonly operationId: string;
  }): Promise<void> {
    if (input.operationId.length === 0) throw new Error("integration_draft_operation_required");
    const key = draftKey(input.approvedPackageDigest, input);
    const entry = this.drafts.get(key);
    if (entry === undefined) return;
    if (entry.claimExpiresAt === undefined || entry.draft.provenance.reviewId !== input.reviewId) {
      throw new Error("integration_draft_acknowledgement_mismatch");
    }
    this.drafts.delete(key);
  }

  private removeExpired(now: number): void {
    for (const [digest, entry] of this.drafts) {
      if ((entry.claimExpiresAt ?? entry.expiresAt) <= now) this.drafts.delete(digest);
    }
  }

  private makeRoom(): void {
    for (const [key, entry] of this.drafts) {
      if (this.drafts.size < this.maxDrafts) return;
      if (entry.claimExpiresAt === undefined) this.drafts.delete(key);
    }
    if (this.drafts.size >= this.maxDrafts) throw new Error("integration_draft_capacity_exhausted");
  }
}
