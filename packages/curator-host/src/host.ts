import { createHash } from "node:crypto";
import {
  type CuratorEffect,
  type CuratorSubject,
  type PromptTurn,
  parseCuratorBusinessOutput,
  parseCuratorUserOutput,
  planBusinessEffects,
  planUserEffects,
  type SubjectResolver,
} from "@tulipfarm/curator";
import {
  hashMemorySection,
  MEMORY_SECTION_CHAR_BUDGET,
  type MemoryDocumentRepo,
  renderMemoryDocument,
} from "@tulipfarm/memory";
import { MEMORY_SECTION_KEYS, type MemorySections } from "@tulipfarm/schema";
import type {
  CuratorCandidateRecord,
  CuratorContextPin,
  CuratorEffectKind,
  CuratorJobRecord,
  CuratorRepo,
} from "@tulipfarm/storage";
import { CuratorSettlementConflictError } from "@tulipfarm/storage";

/** Reads the exact Turns a job was pinned to. Nothing outside them can support a claim. */
export interface CuratorTurnReader {
  read(businessId: string, turnIds: readonly string[]): Promise<PromptTurn[]>;
}

export type { CuratorSubject };

export interface CuratorHostDeps {
  readonly repo: CuratorRepo;
  readonly documents: MemoryDocumentRepo;
  readonly turns: CuratorTurnReader;
  subjects(): readonly CuratorSubject[];
  /** Dedupe keys of the Proposals already live for this audience, so the Curator can skip them. */
  openProposalKeys(businessId: string, userId: string): Promise<readonly string[]>;
  soulSummary(): string;
  /** The live Soul's digest. A business job that no longer matches the Soul it was minted against
   * would reason over artifacts that have since changed, so it is retired rather than served. */
  soulDigest(): string;
}

export type CuratorHostDenial =
  | "job_not_found"
  | "digest_mismatch"
  | "already_settled"
  | "context_drifted"
  | "context_not_resolved";

export class CuratorHostError extends Error {
  constructor(readonly code: CuratorHostDenial) {
    super(code);
    this.name = "CuratorHostError";
  }
}

interface Plan {
  readonly effects: readonly CuratorEffect[];
  readonly rejections: readonly { effect: string; reason: string; detail?: string }[];
}

function executionMode(effect: CuratorEffect): "apply" | "shadow" {
  return effect.kind === "proposal" && effect.deliver.includes("task") ? "apply" : "shadow";
}

/**
 * Serves the pinned half of the Curator protocol.
 *
 * The Worker calls the model, but it is an untrusted proposer just as the model is, so the context
 * it is handed is resolved here and every check is re-derived here from those same pinned inputs.
 * Nothing in this class applies an effect: it records what was proposed and why anything was
 * dropped, and the apply path is separate by construction.
 */
export class CuratorHost {
  constructor(private readonly deps: CuratorHostDeps) {}

  private async job(businessId: string, jobId: string): Promise<CuratorJobRecord> {
    const job = await this.deps.repo.getJob(businessId, jobId);
    if (!job) throw new CuratorHostError("job_not_found");
    return job;
  }

  async context(businessId: string, jobId: string): Promise<Record<string, unknown>> {
    const job = await this.job(businessId, jobId);
    const shared = { jobId: job.id, scope: job.scope, contextDigest: job.manifestDigest };
    if (job.scope === "business") {
      const candidates = await this.deps.repo.readCandidates(
        businessId,
        "knowledge_promotion",
        job.manifest.candidateIds
      );
      const soulDigest = this.deps.soulDigest();
      if (job.manifest.soulDigest !== undefined && job.manifest.soulDigest !== soulDigest) {
        throw new CuratorHostError("context_drifted");
      }
      await this.pin(job, {
        memoryRevisionId: null,
        sectionHashes: {},
        candidateDigest: candidateDigest(candidates),
        seedDigest: candidateDigest([]),
        soulDigest,
      });
      return {
        ...shared,
        soulSummary: this.deps.soulSummary(),
        candidates: project(candidates, "statement"),
      };
    }

    const userId = job.userId ?? "";
    const [document, turns, openProposalKeys, seeds] = await Promise.all([
      this.deps.documents.read(businessId, userId),
      this.deps.turns.read(businessId, job.manifest.turnIds),
      this.deps.openProposalKeys(businessId, userId),
      this.deps.repo.readCandidates(businessId, "proposal_seed", job.manifest.seedIds ?? []),
    ]);
    // Remaining room, not the ceiling. The ceiling alone would let the Curator propose a write the
    // store then rejects, which reads in the metrics as a model failure rather than a full section.
    const sectionCharsRemaining: Record<string, number> = {};
    for (const key of MEMORY_SECTION_KEYS) {
      const used = document?.sections[key].length ?? 0;
      sectionCharsRemaining[key] = Math.max(0, MEMORY_SECTION_CHAR_BUDGET - used);
    }
    await this.pin(job, {
      memoryRevisionId: document?.revisionId ?? null,
      sectionHashes: sectionHashes(document?.sections),
      candidateDigest: candidateDigest([]),
      seedDigest: candidateDigest(seeds),
      soulDigest: null,
    });
    return {
      ...shared,
      userId,
      memoryDocument: document ? renderMemoryDocument(document.sections) : "",
      sectionCharsRemaining,
      turns,
      subjects: this.deps.subjects(),
      openProposalKeys,
      seeds: project(seeds, "rationale"),
    };
  }

  /**
   * Fixes what this job saw, or refuses to serve it.
   *
   * The manifest binds *which* rows the job reasons over; this binds *what they said*. Serving a
   * second, different resolution would let output reasoned against one version of a document be
   * validated against another — so a job whose content moved is retired and re-minted rather than
   * quietly re-based.
   */
  private async pin(
    job: CuratorJobRecord,
    resolved: CuratorContextPin
  ): Promise<CuratorContextPin> {
    const inForce = await this.deps.repo.pinContext(job.id, resolved);
    if (!samePin(inForce, resolved)) throw new CuratorHostError("context_drifted");
    return inForce;
  }

  /**
   * Takes raw model output and the digest of the context it came from, never an effect the Worker
   * mapped for us. The digest binds the output to a job's manifest: a mismatch means it was
   * produced from different inputs than the ones about to be reloaded.
   */
  async submit(
    businessId: string,
    jobId: string,
    contextDigest: string,
    output: unknown
  ): Promise<{ recorded: number; rejected: number; scope: CuratorJobRecord["scope"] }> {
    const job = await this.job(businessId, jobId);
    if (contextDigest !== job.manifestDigest) throw new CuratorHostError("digest_mismatch");
    const pin = job.contextPin;
    // Output can only be checked against inputs someone recorded. No pin means nothing ever
    // resolved this job's context, so there is nothing to validate the answer against.
    if (!pin) throw new CuratorHostError("context_not_resolved");

    const plan =
      job.scope === "business" ? this.planBusiness(job, output) : await this.planUser(job, output);
    const drift = await this.driftedSections(job, pin);
    const kept: CuratorEffect[] = [];
    const rejections = [...plan.rejections];
    for (const effect of plan.effects) {
      if (effect.kind === "memory_patch" && drift.has(effect.section)) {
        // Per section, not per document: an unrelated section moving must not throw away work the
        // Curator did on a section nobody touched.
        rejections.push({ effect: effect.kind, reason: "section_changed", detail: effect.section });
        continue;
      }
      kept.push(effect);
    }
    const effects = kept.map((effect) => ({
      kind: effect.kind as CuratorEffectKind,
      payload: effect,
      executionMode: executionMode(effect),
    }));
    try {
      const { recorded, rejected } = await this.deps.repo.settle({
        job,
        outputDigest: createHash("sha256")
          .update(JSON.stringify(output) ?? "")
          .digest("hex"),
        generation: 1,
        effects,
        rejections,
      });
      return { recorded, rejected, scope: job.scope };
    } catch (error) {
      if (error instanceof CuratorSettlementConflictError) {
        throw new CuratorHostError("already_settled");
      }
      throw error;
    }
  }

  /** Sections whose content moved between context resolution and this answer arriving. */
  private async driftedSections(
    job: CuratorJobRecord,
    pin: CuratorContextPin
  ): Promise<ReadonlySet<string>> {
    if (job.scope !== "user") return new Set();
    const document = await this.deps.documents.read(job.businessId, job.userId ?? "");
    const current = sectionHashes(document?.sections);
    return new Set(
      MEMORY_SECTION_KEYS.filter((key) => (pin.sectionHashes[key] ?? "") !== (current[key] ?? ""))
    );
  }

  private async planUser(job: CuratorJobRecord, output: unknown): Promise<Plan> {
    const parsed = parseCuratorUserOutput(output);
    if (!parsed.ok) return { effects: [], rejections: [outputRejection(parsed.rejection)] };
    const turns = await this.deps.turns.read(job.businessId, job.manifest.turnIds);
    const labels = new Map(
      this.deps.subjects().map((s) => [`${s.kind}:${s.id}`, s.label] as const)
    );
    const resolveSubject: SubjectResolver = (kind, id) => labels.get(`${kind}:${id}`);
    return planUserEffects(parsed.output, {
      turns,
      resolveSubject,
      sectionCharBudget: MEMORY_SECTION_CHAR_BUDGET,
    });
  }

  private planBusiness(job: CuratorJobRecord, output: unknown): Plan {
    const parsed = parseCuratorBusinessOutput(output);
    if (!parsed.ok) return { effects: [], rejections: [outputRejection(parsed.rejection)] };
    return planBusinessEffects(parsed.output, {
      candidateIds: job.manifest.candidateIds,
      knowledgeSourceKey,
    });
  }
}

function sectionHashes(sections: MemorySections | undefined): Record<string, string> {
  const hashes: Record<string, string> = {};
  for (const key of MEMORY_SECTION_KEYS) hashes[key] = hashMemorySection(sections?.[key] ?? "");
  return hashes;
}

/** Binds a candidate set by what it *said*, not merely by which ids were named. */
function candidateDigest(candidates: readonly CuratorCandidateRecord[]): string {
  return createHash("sha256")
    .update(JSON.stringify(candidates.map((c) => [c.id, c.payload])))
    .digest("hex");
}

function samePin(a: CuratorContextPin, b: CuratorContextPin): boolean {
  return (
    a.memoryRevisionId === b.memoryRevisionId &&
    a.candidateDigest === b.candidateDigest &&
    a.seedDigest === b.seedDigest &&
    a.soulDigest === b.soulDigest &&
    MEMORY_SECTION_KEYS.every((key) => a.sectionHashes[key] === b.sectionHashes[key])
  );
}

/** Page identity follows the candidates a page was built from, so regeneration lands on it again. */
function knowledgeSourceKey(candidateIds: readonly string[]): string {
  const digest = createHash("sha256")
    .update([...candidateIds].sort().join("\n"))
    .digest("hex");
  return `curator-knowledge:${digest.slice(0, 32)}`;
}

/**
 * Flattens a candidate's stored payload onto the one field the prompt reads.
 *
 * A candidate carrying no usable text is dropped rather than sent with an empty field: the model is
 * shown candidate ids so it can cite them, and an id with nothing behind it is a citable handle to
 * nothing.
 */
function project<K extends string>(
  candidates: readonly { readonly id: string; readonly payload: unknown }[],
  field: K
): { readonly id: string; readonly [key: string]: string }[] {
  const projected: { id: string; [key: string]: string }[] = [];
  for (const candidate of candidates) {
    const value = (candidate.payload as Record<string, unknown> | null)?.[field];
    if (typeof value !== "string" || value.length === 0) continue;
    projected.push({ id: candidate.id, [field]: value });
  }
  return projected;
}

function outputRejection(rejection: { reason: string; detail?: string }): {
  effect: string;
  reason: string;
  detail?: string;
} {
  const detail = rejection.detail;
  return { effect: "output", reason: rejection.reason, ...(detail ? { detail } : {}) };
}
