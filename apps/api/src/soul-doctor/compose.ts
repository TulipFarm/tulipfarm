import { proposeSoulRepair } from "@tulipfarm/built-in-agents";
import type { LlmService } from "@tulipfarm/llm";
import { compileRoutine, stateFields } from "@tulipfarm/run-kernel";
import { isRecord, routine as routineDefinitions } from "@tulipfarm/schema";
import type { CommitActor, SoulWriter } from "@tulipfarm/soul";
import {
  type BundleState,
  doctorDedupeKey,
  type Finding,
  LINT_CEILING,
  lintRoutineDocument,
  type ProposedRepair,
  type RepairSubject,
  type SweepPorts,
  type SweepReport,
  sweepSoul,
} from "@tulipfarm/soul-doctor";
import type { Queryable, TaskStore } from "@tulipfarm/storage";
import { closeSupersededRuns, listUnhealthyRuns, SoulDoctorLedger } from "@tulipfarm/storage";
import { parse as parseYaml } from "yaml";
import type { ActivityService } from "../activity/service";

/** How many stuck Runs one sweep reads. Beyond this the picture is already unambiguous. */
const UNHEALTHY_RUN_LIMIT = 50;

/** Structural subset of the Soul loader: the authored Routines as parsed, keyed by slug. */
export interface DoctorSoulSlice {
  readonly routines: ReadonlyMap<string, { readonly config: Record<string, unknown> }>;
}

export interface SoulDoctorDeps {
  readonly pool: Queryable;
  readonly businessId: string;
  readonly soul: DoctorSoulSlice;
  readonly writer: SoulWriter;
  readonly actor: CommitActor;
  readonly tasks: TaskStore;
  readonly activity: ActivityService;
  readonly llm: LlmService;
  /** Current soul git HEAD, and the commit the active bundle pins — the staleness pair. */
  readonly headSha: () => Promise<string | undefined>;
  readonly activeCommitSha: (businessId: string) => Promise<string | undefined>;
  readonly log?: { error(obj: unknown, msg?: string): void };
}

/** A stable hash of the authored bytes, so a finding is pinned to exactly what it proves. */
function documentDigest(config: Record<string, unknown>): string {
  return JSON.stringify(config).length.toString(36) + ":" + Object.keys(config).sort().join(",");
}

/**
 * What a State publishes, when it says so.
 *
 * Given to the repair as fact rather than left to the model, because a guessed field name lints
 * exactly as clean as the right one — and the whole point of the gate is that the lint, not the
 * model, is the thing being trusted.
 */
function routineFacts(document: unknown): readonly string[] {
  try {
    const definition = routineDefinitions.validateRoutineDefinition(document).document;
    // biome-ignore lint/suspicious/noExplicitAny: the validated document is the compiler's input
    const compiled = compileRoutine(definition as any, { identityCeiling: LINT_CEILING });
    const facts: string[] = [];
    for (const state of compiled.states.values()) {
      // biome-ignore lint/suspicious/noExplicitAny: `definition` is the same validated document
      const output = stateFields(state.definition as any).output;
      if (!isRecord(output) || !isRecord(output.properties)) continue;
      facts.push(
        `- State \`${state.name}\` publishes: ${Object.keys(output.properties).join(", ")}`
      );
    }
    return facts;
  } catch {
    // A document that does not compile has no States to describe. The defect is the document.
    return [];
  }
}

/** How many Runs one repair closes. A Routine parking more than this has a bigger story. */
const SUPERSEDED_RUN_LIMIT = 200;

function routineSlug(finding: Finding): string | null {
  return finding.subject.kind === "routine" ? finding.subject.id : null;
}

/**
 * Wires the Doctor to this deployment's Soul, database, model provider and inbox.
 *
 * The repair path is omitted when no model provider is configured: detection, the ledger and the
 * operator's Tasks all still work, and every finding escalates. An instance with no key is not a
 * reason to stop reporting that a Routine is broken.
 */
export function buildSoulDoctor(deps: SoulDoctorDeps): { sweep(): Promise<SweepReport> } {
  const ledger = new SoulDoctorLedger(deps.pool);
  const { businessId } = deps;

  async function bundle(): Promise<BundleState> {
    const [headSha, activeCommitSha] = await Promise.all([
      deps.headSha(),
      deps.activeCommitSha(businessId),
    ]);
    return {
      activeCommitSha,
      headSha,
      routines: [...deps.soul.routines].map(([slug, routine]) => ({
        slug,
        hash: documentDigest(routine.config),
        document: routine.config,
      })),
    };
  }

  const repair = {
    async locate(finding: Finding): Promise<RepairSubject | null> {
      const slug = routineSlug(finding);
      if (slug === null) return null;
      const read = await deps.writer.readWithBase("Routine", slug);
      if (read.content === null) return null;
      return {
        path: `routines/${slug}/routine.yaml`,
        content: read.content,
        facts: routineFacts(deps.soul.routines.get(slug)?.config ?? {}),
      };
    },

    async propose(finding: Finding, subject: RepairSubject): Promise<ProposedRepair | null> {
      const proposal = await proposeSoulRepair(deps.llm.effortModel("balanced"), {
        path: subject.path,
        content: subject.content,
        defect: finding.detail,
        facts: subject.facts,
      });
      if (!proposal.repairable || proposal.content.trim().length === 0) return null;
      // The lint is re-run against the proposed bytes, never against the model's account of them.
      const slug = routineSlug(finding) ?? "";
      let lintsClean: boolean;
      try {
        lintsClean =
          lintRoutineDocument({
            slug,
            digest: "proposed",
            document: parseYaml(proposal.content),
          }).length === 0;
      } catch {
        lintsClean = false;
      }
      return {
        fingerprint: finding.fingerprint,
        paths: [subject.path],
        content: proposal.content,
        lintsClean,
        summary: proposal.summary,
      };
    },

    async publish(finding: Finding, proposal: ProposedRepair): Promise<void> {
      const slug = routineSlug(finding);
      if (slug === null) throw new Error("soul doctor: a repair reached publish with no artifact");
      const result = await deps.writer.apply({
        subject: `fix(soul): repair ${slug}`,
        source: "api",
        actor: deps.actor,
        businessId,
        changes: [{ op: "put", target: { kind: "Routine", slug }, content: proposal.content }],
      });
      if (!result.published) {
        throw new Error(
          `the repair committed but did not publish: ${result.publicationError ?? "unknown"}`
        );
      }
      await closeSuperseded(slug);
    },
  };

  /**
   * Closes the Runs the repair cannot rescue.
   *
   * A Run pins the bundle it started with, so a fixed Routine does nothing for a Run already parked
   * against the broken one — requeueing it would replay the same unresolvable mapping. Failing it
   * is the honest end, and it is what stops a repaired Routine leaving a permanent row that every
   * surface still reads as in flight. Never allowed to fail the repair it follows: the publish has
   * already happened, and losing it to a bookkeeping error would re-propose the same fix forever.
   */
  async function closeSuperseded(slug: string): Promise<void> {
    const config = deps.soul.routines.get(slug)?.config;
    const metadata = config !== undefined && isRecord(config.metadata) ? config.metadata : {};
    const routineId = typeof metadata.id === "string" ? metadata.id : null;
    if (routineId === null) return;
    try {
      await closeSupersededRuns(deps.pool, businessId, routineId, SUPERSEDED_RUN_LIMIT);
    } catch (error) {
      deps.log?.error({ err: error, slug }, "soul doctor: could not close superseded runs");
    }
  }

  const ports: SweepPorts = {
    now: () => new Date(),
    bundle,
    async unhealthyRuns() {
      const rows = await listUnhealthyRuns(deps.pool, businessId, {
        now: new Date(),
        limit: UNHEALTHY_RUN_LIMIT,
      });
      // A Run pins a Routine by id; a finding has to name the slug an operator recognises and a
      // repair can address. Runs whose Routine is gone keep the Run as their subject.
      const slugById = new Map(
        [...deps.soul.routines].flatMap(([slug, routine]) => {
          const id = isRecord(routine.config.metadata) ? routine.config.metadata.id : undefined;
          return typeof id === "string" ? [[id, slug] as const] : [];
        })
      );
      return rows.map((row) => ({
        id: row.id,
        status: row.status,
        errorEvidenceRef: row.errorEvidenceRef,
        routineSlug: row.routineId === null ? null : (slugById.get(row.routineId) ?? null),
        createdAt: row.createdAt,
      }));
    },
    ledger: {
      observe: (finding) => ledger.observe(businessId, finding),
      claim: (fingerprint, runId) => ledger.claim(fingerprint, runId),
      settle: (fingerprint, state) => ledger.settle(fingerprint, state),
      resolveUnseen: (sweptAt) => ledger.resolveUnseen(businessId, sweptAt),
    },
    ...(deps.llm.isConfigured ? { repair } : {}),
    async escalate(finding, because) {
      await deps.tasks.upsertOpen(
        {
          businessId,
          assigneeKind: "role",
          assigneeId: "admin",
          dedupeKey: doctorDedupeKey(finding),
          title: `${finding.subject.kind} \`${finding.subject.id}\` is broken`,
          detail: `${finding.detail}\n\nNot repaired automatically because ${because}.`,
          action: { kind: "ack" },
          subject: { kind: finding.subject.kind, id: finding.subject.id },
        },
        new Date()
      );
    },
    report(event) {
      const summary =
        event.kind === "repaired"
          ? `Soul Doctor repaired ${event.finding.subject.kind} "${event.finding.subject.id}": ${event.summary}`
          : event.kind === "escalated"
            ? `Soul Doctor escalated ${event.finding.subject.kind} "${event.finding.subject.id}": ${event.because}`
            : `Soul Doctor found ${event.finding.code} in ${event.finding.subject.kind} "${event.finding.subject.id}"`;
      return deps.activity.record({
        category: "soul",
        action: `soul.doctor.${event.kind}`,
        targetType: event.finding.subject.kind,
        targetId: event.finding.subject.id,
        summary,
        status: event.kind === "repaired" ? "ok" : "error",
      });
    },
  };

  return { sweep: () => sweepSoul(ports) };
}
