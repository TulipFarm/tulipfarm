/**
 * The L3 tier's real File store, so a Case can assert the lifecycle of what an Agent generated.
 *
 * Every other Tool in this framework is scripted, and for nearly all of them that is right: a Case
 * cares what the model *asked* a Tool to do, not what the Tool then did. `file_create` is the
 * exception, because the property worth measuring is not in the call at all. A Chat call becomes
 * an expiring draft while a Routine call becomes a persistent File, based on server-only context
 * the model never sees and cannot influence. A scripted result would hand back whichever lifecycle
 * the Case author wrote and prove nothing about what the product actually did.
 *
 * So `file_create` runs for real here: the product's own Tool handler, over the product's own
 * `FileService`, against the real draft/File tables, with `rolesOf` wired to the production
 * `collectHeldRoleIds` rather than to a fixture map. The only substitution is the blob port, which
 * is in memory because the bytes are not what is being measured.
 *
 * It is also why {@link seedAgentRoles} writes `role_assignments` rather than reading the Agent's
 * Soul `roles:` list. That list is advisory metadata — `reconcileSoulRoles` projects Role
 * *definitions* and creates no assignment — so a fixture that read it would measure a mapping the
 * product does not have, and would go on passing after live authority stopped reaching Files.
 */

import { createHash, randomUUID } from "node:crypto";
import type { ToolDispatchPort, ToolDispatchResult } from "@tulipfarm/agent-runtime";
import {
  type FileGrantee,
  type FileRepo,
  FileService,
  fileCreateTool,
  PgFileRepo,
} from "@tulipfarm/files";
import {
  type BlobPort,
  collectBlobBytes,
  PgPrincipalRepo,
  PgRoleRepo,
  PgTeamRepo,
} from "@tulipfarm/storage";
import { collectHeldRoleIds } from "@tulipfarm/tool-host";
import type { EvalDatabase } from "./database.ts";

/** The one Tool this store answers for; everything else stays scripted. */
export const FILE_CREATE_TOOL = "file_create";

/** One File a Turn generated, with the audience the product gave it. */
export interface GeneratedFile {
  readonly fileId: string;
  readonly filename: string;
  /** Every grantee that may read it, as `kind:id` — the spelling a Case's Expectation uses. */
  readonly readableBy: readonly string[];
  readonly status: "draft" | "saved";
}

export interface EvalFileStore {
  readonly port: ToolDispatchPort;
  /** Files generated so far, in creation order. Accumulates across a journey's Turns. */
  readonly generated: readonly GeneratedFile[];
}

/** `kind:id` — the one spelling a Case writes and this tier reports. */
export function granteeLabel(grantee: Pick<FileGrantee, "kind" | "id">): string {
  return `${grantee.kind}:${grantee.id}`;
}

/**
 * Content-addressed bytes held in memory.
 *
 * Generation also checks `head` while holding the blob-reference lock, so that operation reports
 * the bytes just stored. Reads and deletes still fail loudly because no Eval Case uses them.
 */
function memoryBlobs(): BlobPort {
  const objects = new Map<string, Uint8Array>();
  const unsupported = (method: string) => (): never => {
    throw new Error(`the L3 File store does not implement blobs.${method}`);
  };
  return {
    put: async (body) => {
      const bytes = body instanceof Uint8Array ? body : await collectBlobBytes(body);
      const hash = createHash("sha256").update(bytes).digest("hex");
      objects.set(hash, bytes);
      return { key: `eval/${hash}`, hash };
    },
    get: unsupported("get"),
    head: async (ref) => {
      const bytes = objects.get(ref.hash);
      return bytes === undefined ? null : { size: bytes.byteLength };
    },
    delete: unsupported("delete"),
  };
}

/**
 * Registers the Agent's Principal and assigns it the given Roles, as an admin would.
 *
 * `role_assignments` has foreign keys to both `principals` and `roles`, so all three rows are
 * written — the same three `/business/access/agents` produces when an admin gives an Agent a team.
 * The Role carries no grants: this fixture is about *audience*, and a Role that granted authority
 * would quietly widen what the Agent may do as well as who may read what it wrote.
 */
export async function seedAgentRoles(options: {
  readonly database: EvalDatabase;
  readonly businessId: string;
  readonly agentId: string;
  readonly roleIds: readonly string[];
}): Promise<void> {
  const { database, businessId, agentId, roleIds } = options;
  if (roleIds.length === 0) return;
  // Written with SQL rather than through `PrincipalRepo`, whose record carries a status lifecycle,
  // an expiry and external identity links this fixture has no business inventing. The only fact
  // the audience rule needs is that an active `agent` Principal exists for the foreign key.
  await database.query(
    `INSERT INTO principals (business_id, id, kind, status)
     VALUES ($1, $2, 'agent', 'active')
     ON CONFLICT (business_id, id) DO NOTHING`,
    [businessId, agentId]
  );
  const roles = new PgRoleRepo(database.transactions);
  for (const roleId of roleIds) {
    await roles.putRole({
      id: roleId,
      businessId,
      assignableTo: ["agent", "user"],
      parentRoleIds: [],
      grants: [],
    });
    await roles.assign({ businessId, principalId: agentId, roleId });
  }
}

export interface EvalFileStoreOptions {
  readonly database: EvalDatabase;
  readonly businessId: string;
  /** The person the Turn runs for; a generated File is readable by them either way. */
  readonly principalId: string;
  /** The Agent the Turn runs as, whose Roles widen the audience of what it writes. */
  readonly agentId: string;
  /** The Run a generated File records as its provenance. */
  readonly runId: () => string;
}

/**
 * Dispatches `file_create` through the product's own handler and records the lifecycle it produced.
 *
 * For an automatically saved output, share rows are read back rather than predicted. A Chat draft
 * deliberately has no File audience yet.
 */
export function evalFileStore(options: EvalFileStoreOptions): EvalFileStore {
  const { database, businessId, principalId, agentId } = options;
  const repo: FileRepo = new PgFileRepo(database.queryable);
  const service = new FileService({
    repo,
    blobs: memoryBlobs(),
    newId: randomUUID,
    rolesOf: (business, principal) =>
      collectHeldRoleIds(
        {
          principals: new PgPrincipalRepo(database.transactions),
          roles: new PgRoleRepo(database.transactions),
          teams: new PgTeamRepo(database.transactions),
        },
        business,
        principal,
        new Date()
      ),
  });

  const generated: GeneratedFile[] = [];
  return {
    generated,
    port: {
      dispatch: async (request): Promise<ToolDispatchResult> => {
        const result = await fileCreateTool.handler(request.arguments, {
          businessId,
          principalId,
          agentId,
          runId: options.runId(),
          toolCallId: request.callId,
          service,
        });
        if (!result.success) {
          return { status: "failed", callId: request.callId, reason: result.error.message };
        }
        const data = result.data as {
          status: "draft" | "saved";
          draftId?: string;
          fileId?: string;
          filename: string;
        };
        const fileId = data.fileId ?? data.draftId;
        if (fileId === undefined) {
          return {
            status: "failed",
            callId: request.callId,
            reason: "file_create returned no output id",
          };
        }
        const shares = data.status === "saved" ? await repo.listShares(businessId, fileId) : [];
        generated.push({
          fileId,
          filename: data.filename,
          readableBy: shares.map(granteeLabel),
          status: data.status,
        });
        return { status: "succeeded", callId: request.callId, output: data };
      },
    },
  };
}
