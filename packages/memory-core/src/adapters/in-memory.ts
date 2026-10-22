import { AsyncLocalStorage } from 'node:async_hooks';
import type { MemoryRepository } from '../ports/memory-repository.ts';
import type { MemoryReconciliationRepository } from '../ports/memory-reconciliation-repository.ts';
import type { TranscriptSource } from '../ports/transcript-source.ts';
import type { TenantRuntime } from '../ports/tenant-runtime.ts';
import type { Clock } from '../ports/runtime.ts';
import type { RepositoryResult } from '../ports/repository-result.ts';

export type InMemoryContext = Readonly<{ tenantId: string }>;

type MemoryRow = {
  content: string;
  revision: number;
  manual_updated_at: string | null;
  reconciled_through: string | null;
};
type Progress = {
  memory_complete: boolean;
  memory_chunk: number;
  memory_step: number;
  memory_base_revision: number | null;
  memory_manual_at: string | null;
  memory_reconciled_through: string | null;
};
type Job = Progress & {
  conversationId: string;
  membershipId: string;
  generation: number;
  coveredThrough: number | null;
};
type Message = {
  id: string;
  conversationId: string;
  membershipId: string | null;
  authorKind: string;
  sequence: number;
  acceptedSequence: number;
  createdAt: string;
  internal: boolean;
  parts: { ordinal: number; kind: string; text: string | null }[];
};

export type InMemorySeed = {
  memories?: ({ membershipId: string } & Partial<MemoryRow>)[];
  conversations?: { id: string; owner_membership_id: string | null; project_id: string | null }[];
  jobs?: ({
    id: string;
    conversationId: string;
    membershipId: string;
    generation: number;
    coveredThrough: number | null;
  } & Partial<Progress>)[];
  steps?: { jobId: string; purpose: string }[];
  messages?: Message[];
};
type State = {
  memories: Map<string, MemoryRow>;
  conversations: Map<string, { owner_membership_id: string | null; project_id: string | null }>;
  jobs: Map<string, Job>;
  steps: { jobId: string; purpose: string }[];
  messages: Map<string, Message>;
};

function emptyState(): State {
  return { memories: new Map(), conversations: new Map(), jobs: new Map(), steps: [], messages: new Map() };
}

function result(...rows: Record<string, unknown>[]): RepositoryResult {
  return { rows: structuredClone(rows), rowCount: rows.length };
}

function changed(found: boolean): RepositoryResult {
  return { rows: [], rowCount: found ? 1 : 0 };
}

function time(value: string): bigint {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new RangeError('Invalid memory timestamp');
  const fraction = value.match(/\d{2}:\d{2}:\d{2}\.(\d+)/)?.[1] ?? '';
  if (fraction.length > 6) throw new RangeError('Unsupported memory timestamp precision');
  return BigInt(milliseconds) * 1000n + BigInt(fraction.padEnd(6, '0').slice(3));
}

function greatest(left: string | null, right: string | null): string | null {
  if (left !== null) time(left);
  if (right !== null) time(right);
  if (left === null) return right;
  if (right === null) return left;
  return time(left) >= time(right) ? left : right;
}

function progress(row: Job): Progress {
  const {
    memory_complete,
    memory_chunk,
    memory_step,
    memory_base_revision,
    memory_manual_at,
    memory_reconciled_through,
  } = row;
  return {
    memory_complete,
    memory_chunk,
    memory_step,
    memory_base_revision,
    memory_manual_at,
    memory_reconciled_through,
  };
}

export class InMemoryDeadlineExceeded extends Error {
  constructor() {
    super('Memory transaction deadline exceeded');
    this.name = 'InMemoryDeadlineExceeded';
  }
}

/**
 * A transactional reference for the personal-memory ports, not a host authorizer.
 * Contexts are valid only inside their tenant's transaction callback.
 */
export function createInMemoryMemoryAdapters({ clock }: { clock: Pick<Clock, 'now'> }) {
  const tenants = new Map<string, State>();
  const active = new WeakMap<InMemoryContext, State>();
  const queues = new Map<string, Promise<void>>();
  const executing = new AsyncLocalStorage<readonly InMemoryContext[]>();
  function state(context: InMemoryContext): State {
    const value = active.get(context);
    if (!value) throw new Error('Inactive or foreign memory transaction');
    return value;
  }
  const runtime: TenantRuntime<InMemoryContext> = {
    async transaction(tenantId, options, operation) {
      const parents = executing.getStore() ?? [];
      if (parents.some(context => context.tenantId === tenantId && active.has(context)))
        throw new Error('Nested memory transaction for the same tenant');
      const previous = queues.get(tenantId) ?? Promise.resolve();
      let release!: () => void;
      const gate = new Promise<void>(resolve => {
        release = resolve;
      });
      const tail = previous.then(() => gate);
      queues.set(tenantId, tail);
      await previous;
      const checkDeadline = () => {
        const now = clock.now();
        if (!Number.isFinite(now) || (options.deadlineAt !== undefined && !Number.isFinite(options.deadlineAt)))
          throw new RangeError('Invalid memory transaction time');
        if (options.deadlineAt !== undefined && now >= options.deadlineAt) throw new InMemoryDeadlineExceeded();
      };
      try {
        checkDeadline();
        const snapshot = structuredClone(tenants.get(tenantId) ?? emptyState());
        const context = Object.freeze({ tenantId });
        active.set(context, snapshot);
        try {
          const value = await executing.run([...parents, context], () => operation(context));
          checkDeadline();
          tenants.set(tenantId, snapshot);
          return value;
        } finally {
          active.delete(context);
        }
      } finally {
        release();
        if (queues.get(tenantId) === tail) queues.delete(tenantId);
      }
    },
  };
  const memory = (context: InMemoryContext): MemoryRepository => ({
    async read([id]) {
      const row = state(context).memories.get(id);
      return row ? result({ content: row.content, revision: row.revision }) : result();
    },
    async insert([id, content, automatic, through]) {
      const rows = state(context).memories;
      if (through !== null) time(through);
      if (rows.has(id)) return result();
      rows.set(id, {
        content,
        revision: 1,
        manual_updated_at: automatic ? null : new Date(clock.now()).toISOString(),
        reconciled_through: through,
      });
      return result({ content, revision: 1 });
    },
    async replace([id, content, revision, automatic, through]) {
      const row = state(context).memories.get(id);
      if (!row || row.revision !== revision) return result();
      const manualAt = automatic ? row.manual_updated_at : new Date(clock.now()).toISOString();
      const reconciledThrough = greatest(row.reconciled_through, through);
      row.content = content;
      row.revision++;
      row.manual_updated_at = manualAt;
      row.reconciled_through = reconciledThrough;
      return result({ content: row.content, revision: row.revision });
    },
    async clearPending([id]) {
      const value = state(context);
      const before = value.steps.length;
      value.steps = value.steps.filter(
        step => step.purpose !== 'memory' || value.jobs.get(step.jobId)?.membershipId !== id,
      );
      return { rows: [], rowCount: before - value.steps.length };
    },
  });
  const reconciliation = (context: InMemoryContext): MemoryReconciliationRepository => {
    function update(id: string, operation: (row: Job) => void) {
      const row = state(context).jobs.get(id);
      if (row) operation(row);
      return changed(row !== undefined);
    }
    return {
      async progress([id]) {
        const row = state(context).jobs.get(id);
        return row ? result(progress(row)) : result();
      },
      async owner([id]) {
        const row = state(context).conversations.get(id);
        return row ? result(row) : result();
      },
      async complete([id]) {
        return update(id, row => {
          row.memory_complete = true;
        });
      },
      async timestamps([id]) {
        const row = state(context).memories.get(id);
        return row
          ? result({ manual_updated_at: row.manual_updated_at, reconciled_through: row.reconciled_through })
          : result();
      },
      async completeEmpty([id]) {
        return update(id, row => {
          row.memory_complete = true;
          row.memory_base_revision = null;
        });
      },
      async saveProgress([id, chunk, step, revision, manualAt, through]) {
        if (manualAt !== null) time(manualAt);
        if (through !== null) time(through);
        return update(id, row =>
          Object.assign(row, {
            memory_chunk: chunk,
            memory_step: step,
            memory_base_revision: revision,
            memory_manual_at: manualAt,
            memory_reconciled_through: through,
          }),
        );
      },
      async watermark([id]) {
        const row = state(context).memories.get(id);
        return row ? result({ reconciled_through: row.reconciled_through }) : result();
      },
      async clearStep([id]) {
        const value = state(context);
        const before = value.steps.length;
        value.steps = value.steps.filter(step => step.jobId !== id || step.purpose !== 'memory');
        return { rows: [], rowCount: before - value.steps.length };
      },
      async restart([id]) {
        return update(id, row => {
          row.memory_step++;
          row.memory_base_revision = null;
        });
      },
      async advanceWatermark([id, through]) {
        const row = state(context).memories.get(id);
        if (row) row.reconciled_through = greatest(row.reconciled_through, through);
        return changed(row !== undefined);
      },
      async finish([id, chunk, step, complete]) {
        return update(id, row =>
          Object.assign(row, {
            memory_chunk: chunk,
            memory_step: step,
            memory_base_revision: null,
            memory_complete: complete,
          }),
        );
      },
    };
  };
  const transcript = (context: InMemoryContext): TranscriptSource => ({
    async requesterMessages([conversationId, membershipId, coveredThrough, manualAt, generation]) {
      const value = state(context);
      if (manualAt !== null) time(manualAt);
      if (coveredThrough === null) return result();
      const previous = Math.max(
        0,
        ...[...value.jobs.values()]
          .filter(job => job.conversationId === conversationId && job.generation < generation && job.memory_complete)
          .map(job => job.coveredThrough ?? 0),
      );
      const messages = [...value.messages.values()]
        .filter(
          message =>
            message.conversationId === conversationId &&
            message.membershipId === membershipId &&
            message.authorKind === 'human' &&
            !message.internal &&
            message.acceptedSequence <= coveredThrough &&
            message.acceptedSequence > previous &&
            (manualAt === null || time(message.createdAt) > time(manualAt)) &&
            message.parts.some(part => part.kind === 'text'),
        )
        .sort((left, right) => left.sequence - right.sequence);
      return result(
        ...messages.map(message => {
          const parts = message.parts
            .filter(part => part.kind === 'text' && part.text !== null)
            .sort((left, right) => left.ordinal - right.ordinal);
          return {
            id: message.id,
            createdAt: message.createdAt,
            acceptedSequence: message.acceptedSequence,
            text: parts.length ? parts.map(part => part.text).join('\n') : null,
          };
        }),
      );
    },
  });
  async function seed(tenantId: string, input: InMemorySeed) {
    const copy = structuredClone(input);
    await runtime.transaction(tenantId, {}, async context => {
      const value = state(context);
      for (const { membershipId, ...row } of copy.memories ?? [])
        value.memories.set(membershipId, {
          content: '',
          revision: 1,
          manual_updated_at: null,
          reconciled_through: null,
          ...row,
        });
      for (const { id, ...row } of copy.conversations ?? []) value.conversations.set(id, row);
      for (const { id, ...row } of copy.jobs ?? [])
        value.jobs.set(id, {
          memory_complete: false,
          memory_chunk: 0,
          memory_step: 0,
          memory_base_revision: null,
          memory_manual_at: null,
          memory_reconciled_through: null,
          ...row,
        });
      value.steps.push(...(copy.steps ?? []));
      for (const message of copy.messages ?? []) value.messages.set(message.id, message);
    });
  }
  return { runtime, memory, reconciliation, transcript, seed };
}
