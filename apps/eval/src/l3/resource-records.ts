import type { ToolDispatchPort } from "@tulipfarm/agent-runtime";
import {
  createRecord,
  deleteRecord,
  type ResourceDoc,
  type ResourceRepo,
  type ResourceRepoFactory,
} from "@tulipfarm/resources";
import type { EvalSoul } from "../eval-soul.ts";

export const RECORD_CREATE_TOOL = "record_create";
export const RECORD_DELETE_TOOL = "record_delete";

class MemoryResourceRepo implements ResourceRepo {
  readonly records = new Map<string, ResourceDoc>();

  async insert(doc: ResourceDoc): Promise<void> {
    this.records.set(doc._id, doc);
  }

  async findById(id: string): Promise<ResourceDoc | null> {
    return this.records.get(id) ?? null;
  }

  async findDependents(
    field: string,
    targetId: string,
    limit: number
  ): Promise<readonly ResourceDoc[]> {
    return Array.from(this.records.values())
      .filter((record) => record.deletedAt === undefined && record[field] === targetId)
      .slice(0, limit);
  }

  async replaceOne(id: string, expected: number, doc: ResourceDoc): Promise<boolean> {
    const existing = this.records.get(id);
    if (!existing || existing.version !== expected) return false;
    this.records.set(id, doc);
    return true;
  }
}

class MemoryResourceRepoFactory implements ResourceRepoFactory {
  private readonly repositories = new Map<string, MemoryResourceRepo>();

  forType(type: string): MemoryResourceRepo {
    let repository = this.repositories.get(type);
    if (repository === undefined) {
      repository = new MemoryResourceRepo();
      this.repositories.set(type, repository);
    }
    return repository;
  }

  async withTransaction<T>(
    _lockedTypes: readonly string[],
    operation: (repositories: ResourceRepoFactory) => Promise<T>
  ): Promise<T> {
    return operation(this);
  }
}

export interface EvalResourceRecordState {
  readonly repositories: MemoryResourceRepoFactory;
  nextId: number;
}

export function createEvalResourceRecordState(): EvalResourceRecordState {
  return { repositories: new MemoryResourceRepoFactory(), nextId: 1 };
}

function recordId(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

export function evalResourceRecords(
  state: EvalResourceRecordState,
  soul: EvalSoul
): ToolDispatchPort {
  const ports = () => ({
    catalog: soul.loader.resources,
    repositories: state.repositories,
    counter: async () => 1,
    newRecordId: () => recordId(state.nextId++),
    now: () => new Date("2026-09-17T00:00:00.000Z"),
  });

  return {
    dispatch: async (call) => {
      const args = (call.arguments ?? {}) as Record<string, unknown>;
      const type = typeof args.type === "string" ? args.type : undefined;
      if (type === undefined) {
        return { status: "invalid_arguments", callId: call.callId, reason: "type is required" };
      }
      const resource = soul.loader.resources.get(type);
      if (resource === undefined) {
        return {
          status: "invalid_arguments",
          callId: call.callId,
          reason: `resource type not found: ${type}`,
        };
      }

      if (call.name === RECORD_CREATE_TOOL) {
        const data =
          typeof args.data === "object" && args.data !== null && !Array.isArray(args.data)
            ? (args.data as Record<string, unknown>)
            : undefined;
        if (data === undefined) {
          return { status: "invalid_arguments", callId: call.callId, reason: "data is required" };
        }
        const result = await createRecord({ type, resource, data }, ports());
        if (!result.ok) {
          return {
            status: "invalid_arguments",
            callId: call.callId,
            reason: result.err.body.error,
          };
        }
        return {
          status: "succeeded",
          callId: call.callId,
          output: { id: result.doc._id, version: result.doc.version },
        };
      }

      if (call.name === RECORD_DELETE_TOOL) {
        const id = typeof args.id === "string" ? args.id : undefined;
        const version = typeof args.version === "number" ? args.version : undefined;
        if (id === undefined || version === undefined) {
          return {
            status: "invalid_arguments",
            callId: call.callId,
            reason: "id and version are required",
          };
        }
        const result = await deleteRecord(
          { type, resource, id, expectedVersion: version },
          ports()
        );
        if (!result.ok) {
          return {
            status: "invalid_arguments",
            callId: call.callId,
            reason: result.err.body.error,
          };
        }
        return {
          status: "succeeded",
          callId: call.callId,
          output: { id: result.doc._id, version: result.doc.version },
        };
      }

      return { status: "failed", callId: call.callId, reason: `unknown Tool ${call.name}` };
    },
  };
}
