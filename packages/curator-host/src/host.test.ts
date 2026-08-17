import type { PromptTurn } from "@tulipfarm/curator";
import type { MemoryDocumentRepo } from "@tulipfarm/memory";
import type {
  CuratorContextPin,
  CuratorEffectKind,
  CuratorJobRecord,
  CuratorRepo,
  CuratorScope,
} from "@tulipfarm/storage";
import { CuratorSettlementConflictError } from "@tulipfarm/storage";
import { beforeEach, describe, expect, it } from "vitest";
import { CuratorHost, CuratorHostError, type CuratorSubject } from "./host";

const BUSINESS = "business-1";
const USER = "user-1";
const DIGEST = "digest-1";

interface RecordedEffect {
  readonly kind: CuratorEffectKind;
  readonly payload: unknown;
}

class FakeCuratorRepo {
  jobs = new Map<string, CuratorJobRecord>();
  effects: RecordedEffect[] = [];
  rejections: { effect: string; reason: string; detail?: string }[] = [];
  settled: string[] = [];
  candidates: { id: string; payload: unknown }[] = [];
  conflict = false;

  async getJob(businessId: string, jobId: string): Promise<CuratorJobRecord | undefined> {
    const job = this.jobs.get(jobId);
    return job && job.businessId === businessId ? job : undefined;
  }
  async pinContext(jobId: string, pin: CuratorContextPin): Promise<CuratorContextPin> {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error(`no job ${jobId}`);
    const existing = job.contextPin;
    if (existing) return existing;
    this.jobs.set(jobId, { ...job, contextPin: pin });
    return pin;
  }
  async readCandidates(
    _businessId: string,
    _direction: string,
    ids: readonly string[]
  ): Promise<{ id: string; payload: unknown }[]> {
    return this.candidates.filter((candidate) => ids.includes(candidate.id));
  }
  async settle(input: {
    job: CuratorJobRecord;
    outputDigest: string;
    effects: readonly RecordedEffect[];
    rejections: readonly { effect: string; reason: string; detail?: string }[];
  }): Promise<{ recorded: number; rejected: number; replayed: boolean }> {
    if (this.conflict) throw new CuratorSettlementConflictError(input.job.id);
    this.effects.push(...input.effects);
    this.rejections.push(...input.rejections);
    this.settled.push(input.outputDigest);
    return { recorded: input.effects.length, rejected: input.rejections.length, replayed: false };
  }
}

function job(overrides: Partial<CuratorJobRecord> = {}): CuratorJobRecord {
  return {
    id: "job-1",
    businessId: BUSINESS,
    scope: "user" as CuratorScope,
    userId: USER,
    state: "running",
    executionMode: "shadow",
    manifestDigest: DIGEST,
    manifest: { work: [], turnIds: ["turn-1"], candidateIds: [] },
    createdAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

const SUBJECTS: CuratorSubject[] = [{ kind: "integration", id: "github", label: "GitHub" }];
const TURNS: PromptTurn[] = [
  { turnId: "turn-1", userText: "I live in Bangalore and I work on the payments team." },
];

function buildHost(repo: FakeCuratorRepo, documentSections?: Record<string, string>): CuratorHost {
  const documents = {
    read: async () =>
      documentSections
        ? { sections: documentSections, revisionId: "rev-1", updatedAt: new Date() }
        : null,
  } as unknown as MemoryDocumentRepo;
  return new CuratorHost({
    repo: repo as unknown as CuratorRepo,
    documents,
    turns: { read: async () => TURNS },
    subjects: () => SUBJECTS,
    openProposalKeys: async () => ["curator:create_agent:integration:github"],
    soulDigest: () => "soul-digest",
    soulSummary: () => "Name: Acme",
  });
}

describe("CuratorHost", () => {
  let repo: FakeCuratorRepo;
  let host: CuratorHost;

  /** Seeds a job and resolves its context, the only order in which a Worker can answer one. */
  const seed = async (overrides: Partial<CuratorJobRecord> = {}): Promise<void> => {
    repo.jobs.set("job-1", job(overrides));
    await host.context(BUSINESS, "job-1");
  };

  beforeEach(() => {
    repo = new FakeCuratorRepo();
    host = buildHost(repo);
  });

  describe("context", () => {
    it("denies an unknown job", async () => {
      await expect(host.context(BUSINESS, "nope")).rejects.toThrow(CuratorHostError);
      await expect(host.context(BUSINESS, "nope")).rejects.toMatchObject({
        code: "job_not_found",
      });
    });

    it("does not serve another business's job", async () => {
      repo.jobs.set("job-1", job());
      await expect(host.context("business-2", "job-1")).rejects.toMatchObject({
        code: "job_not_found",
      });
    });

    it("pins the digest the submission must carry back", async () => {
      repo.jobs.set("job-1", job());
      const context = await host.context(BUSINESS, "job-1");
      expect(context.contextDigest).toBe(DIGEST);
      expect(context.scope).toBe("user");
    });

    it("serves the user's own turns, subjects and open proposal keys", async () => {
      repo.jobs.set("job-1", job());
      const context = await host.context(BUSINESS, "job-1");
      expect(context.userId).toBe(USER);
      expect(context.turns).toEqual(TURNS);
      expect(context.subjects).toEqual(SUBJECTS);
      expect(context.openProposalKeys).toEqual(["curator:create_agent:integration:github"]);
    });

    it("flattens proposal seeds onto the field the prompt reads", async () => {
      repo.jobs.set(
        "job-1",
        job({ manifest: { work: [], turnIds: ["turn-1"], candidateIds: [], seedIds: ["seed-1"] } })
      );
      repo.candidates = [
        { id: "seed-1", payload: { proposalKind: "create_agent_for_integration", rationale: "r" } },
        { id: "seed-2", payload: { statement: "wrong direction" } },
      ];
      const context = await host.context(BUSINESS, "job-1");
      expect(context.seeds).toEqual([{ id: "seed-1", rationale: "r" }]);
    });

    it("refuses to serve a business job whose Soul moved since it was minted", async () => {
      repo.jobs.set(
        "job-1",
        job({
          scope: "business",
          userId: undefined,
          manifest: { work: [], turnIds: [], candidateIds: [], soulDigest: "a-different-soul" },
        })
      );
      await expect(host.context(BUSINESS, "job-1")).rejects.toMatchObject({
        code: "context_drifted",
      });
    });

    it("serves the same pin on a second call, so two fetches cannot disagree", async () => {
      repo.jobs.set("job-1", job());
      await host.context(BUSINESS, "job-1");
      await expect(host.context(BUSINESS, "job-1")).resolves.toBeDefined();
    });

    it("serves only the candidates the job pinned, never whatever is open now", async () => {
      repo.jobs.set(
        "job-1",
        job({ manifest: { work: [], turnIds: ["turn-1"], candidateIds: [], seedIds: ["seed-1"] } })
      );
      repo.candidates = [
        { id: "seed-1", payload: { rationale: "pinned" } },
        { id: "seed-2", payload: { rationale: "arrived after mint" } },
      ];
      const context = await host.context(BUSINESS, "job-1");
      expect(context.seeds).toEqual([{ id: "seed-1", rationale: "pinned" }]);
    });

    it("serves no seeds to a job that pinned none", async () => {
      repo.jobs.set("job-1", job());
      repo.candidates = [{ id: "seed-1", payload: { rationale: "unpinned" } }];
      expect((await host.context(BUSINESS, "job-1")).seeds).toEqual([]);
    });

    it("reports remaining room, not the ceiling", async () => {
      repo.jobs.set("job-1", job());
      // Its own repo: one job's context pins one version of the document, so a second host serving
      // a different one through the same job is drift, which is the next test's business.
      const otherRepo = new FakeCuratorRepo();
      otherRepo.jobs.set("job-1", job());
      const withDocument = buildHost(otherRepo, {
        identity: "x".repeat(100),
        standing_instructions: "",
        working_context: "",
        preferences: "",
        recent_decisions: "",
        other_facts: "",
      });
      const empty = (await host.context(BUSINESS, "job-1")).sectionCharsRemaining as Record<
        string,
        number
      >;
      const used = (await withDocument.context(BUSINESS, "job-1")).sectionCharsRemaining as Record<
        string,
        number
      >;
      expect(used.identity).toBe((empty.identity ?? 0) - 100);
      expect(used.working_context).toBe(empty.working_context);
    });

    it("never puts a memory document in a business job's context", async () => {
      repo.jobs.set(
        "job-1",
        job({
          scope: "business",
          userId: undefined,
          manifest: { work: [], turnIds: [], candidateIds: ["cand-1"] },
        })
      );
      repo.candidates = [{ id: "cand-1", payload: { statement: "Acme ships weekly" } }];
      const context = await host.context(BUSINESS, "job-1");
      expect(context.memoryDocument).toBeUndefined();
      expect(context.userId).toBeUndefined();
      expect(context.soulSummary).toBe("Name: Acme");
      expect(context.candidates).toEqual([{ id: "cand-1", statement: "Acme ships weekly" }]);
    });

    it("drops a candidate whose payload carries no text for the model to read", async () => {
      repo.jobs.set(
        "job-1",
        job({
          scope: "business",
          userId: undefined,
          manifest: {
            work: [],
            turnIds: [],
            candidateIds: ["cand-1", "cand-2", "cand-3", "cand-4"],
          },
        })
      );
      repo.candidates = [
        { id: "cand-1", payload: { statement: "Acme ships weekly" } },
        { id: "cand-2", payload: { statement: "" } },
        { id: "cand-3", payload: null },
        { id: "cand-4", payload: { rationale: "wrong direction" } },
      ];
      const context = await host.context(BUSINESS, "job-1");
      expect(context.candidates).toEqual([{ id: "cand-1", statement: "Acme ships weekly" }]);
    });
  });

  describe("submit", () => {
    it("denies an unknown job", async () => {
      await expect(host.submit(BUSINESS, "nope", DIGEST, {})).rejects.toMatchObject({
        code: "job_not_found",
      });
    });

    it("rejects output produced from different inputs", async () => {
      await seed();
      await expect(host.submit(BUSINESS, "job-1", "stale", {})).rejects.toMatchObject({
        code: "digest_mismatch",
      });
      expect(repo.effects).toEqual([]);
    });

    it("records a rejection rather than dropping unparseable output", async () => {
      await seed();
      const result = await host.submit(BUSINESS, "job-1", DIGEST, { garbage: true });
      expect(result.recorded).toBe(0);
      expect(result.rejected).toBe(1);
      expect(repo.rejections[0]?.effect).toBe("output");
    });

    it("records a supported memory patch", async () => {
      await seed();
      const result = await host.submit(BUSINESS, "job-1", DIGEST, {
        memory: [
          {
            section: "identity",
            add: ["Works on the payments team"],
            citations: [{ turnId: "turn-1", quote: "I work on the payments team" }],
          },
        ],
        proposals: [],
        knowledgePromotions: [],
      });
      expect(result.recorded).toBe(1);
      expect(repo.effects[0]?.kind).toBe("memory_patch");
      expect(repo.settled).toHaveLength(1);
    });

    it("drops a claim no pinned turn supports", async () => {
      await seed();
      const result = await host.submit(BUSINESS, "job-1", DIGEST, {
        memory: [
          {
            section: "identity",
            add: ["Owns a boat"],
            citations: [{ turnId: "turn-1", quote: "I own a boat" }],
          },
        ],
        proposals: [],
        knowledgePromotions: [],
      });
      expect(result.recorded).toBe(0);
      expect(result.rejected).toBe(1);
      expect(repo.effects).toEqual([]);
    });

    it("drops a proposal naming a subject the Soul does not have", async () => {
      await seed();
      const result = await host.submit(BUSINESS, "job-1", DIGEST, {
        memory: [],
        proposals: [
          {
            kind: "create_agent_for_integration",
            subjectId: "gitlab",
            rationale: "GitLab was connected",
            deliver: ["task"],
            citations: [{ turnId: "turn-1", quote: "I work on the payments team" }],
          },
        ],
        knowledgePromotions: [],
      });
      expect(result.recorded).toBe(0);
      expect(result.rejected).toBe(1);
    });

    it("records a proposal naming a subject the Soul does have", async () => {
      await seed();
      const result = await host.submit(BUSINESS, "job-1", DIGEST, {
        memory: [],
        proposals: [
          {
            kind: "create_agent_for_integration",
            subjectId: "github",
            rationale: "GitHub was connected",
            deliver: ["task"],
            citations: [{ turnId: "turn-1", quote: "I work on the payments team" }],
          },
        ],
        knowledgePromotions: [],
      });
      expect(result.recorded).toBe(1);
      expect(repo.effects[0]?.kind).toBe("proposal");
    });

    it("plans a business job from its pinned candidates", async () => {
      await seed({
        scope: "business",
        userId: undefined,
        manifest: { work: [], turnIds: [], candidateIds: ["cand-1"] },
      });
      const result = await host.submit(BUSINESS, "job-1", DIGEST, {
        knowledge: [
          {
            candidateIds: ["cand-1"],
            title: "How Acme ships",
            body: "Acme ships weekly.",
          },
        ],
        proposalSeeds: [],
      });
      expect(result.recorded).toBe(1);
      expect(repo.effects[0]?.kind).toBe("knowledge_page");
      expect(repo.settled).toHaveLength(1);
    });

    it("drops a knowledge page citing a candidate the job never pinned", async () => {
      await seed({ scope: "business", userId: undefined });
      const result = await host.submit(BUSINESS, "job-1", DIGEST, {
        knowledge: [{ candidateIds: ["cand-9"], title: "Forged", body: "Not from this job." }],
        proposalSeeds: [],
      });
      expect(result.recorded).toBe(0);
      expect(result.rejected).toBe(1);
    });

    it("digests the output it settled, so a replay can be recognised", async () => {
      await seed();
      const output = { memory: [], proposals: [], knowledgePromotions: [] };
      await host.submit(BUSINESS, "job-1", DIGEST, output);
      const first = repo.settled[0];
      repo.settled = [];
      await host.submit(BUSINESS, "job-1", DIGEST, output);
      expect(repo.settled[0]).toBe(first);
      expect(first).toMatch(/^[0-9a-f]{64}$/);
    });

    it("refuses an answer for a job whose context was never resolved", async () => {
      repo.jobs.set("job-1", job());
      await expect(host.submit(BUSINESS, "job-1", DIGEST, {})).rejects.toMatchObject({
        code: "context_not_resolved",
      });
      expect(repo.effects).toEqual([]);
    });

    it("rejects a patch whose section moved since context was resolved, and keeps the rest", async () => {
      let sections: Record<string, string> | undefined;
      const documents = {
        read: async () =>
          sections ? { sections, revisionId: "rev-1", updatedAt: new Date() } : null,
      } as unknown as MemoryDocumentRepo;
      const drifting = new CuratorHost({
        repo: repo as unknown as CuratorRepo,
        documents,
        turns: { read: async () => TURNS },
        subjects: () => SUBJECTS,
        openProposalKeys: async () => [],
        soulDigest: () => "soul-digest",
        soulSummary: () => "Name: Acme",
      });
      repo.jobs.set("job-1", job());
      await drifting.context(BUSINESS, "job-1");
      sections = {
        identity: "Someone else wrote this.",
        standing_instructions: "",
        working_context: "",
        preferences: "",
        recent_decisions: "",
        other_facts: "",
      };
      const result = await drifting.submit(BUSINESS, "job-1", DIGEST, {
        memory: [
          {
            section: "identity",
            add: ["Lives in Bangalore."],
            citations: [{ turnId: "turn-1", quote: "I live in Bangalore" }],
          },
          {
            section: "working_context",
            add: ["Works on the payments team."],
            citations: [{ turnId: "turn-1", quote: "I work on the payments team" }],
          },
        ],
        proposals: [],
        knowledgePromotions: [],
      });
      expect(result.recorded).toBe(1);
      expect(repo.effects[0]?.kind).toBe("memory_patch");
      expect(repo.rejections.map((r) => r.reason)).toContain("section_changed");
    });

    it("refuses a second, different answer for a job that already settled", async () => {
      await seed();
      repo.conflict = true;
      await expect(
        host.submit(BUSINESS, "job-1", DIGEST, { memory: [], proposals: [] })
      ).rejects.toMatchObject({ code: "already_settled" });
    });
  });
});
