/**
 * Resolves an Integration's declared Knowledge roles into a plan a Routine can execute.
 *
 * Nothing here reaches the network or starts a sync. Installing an Integration that declares the
 * profile must remain inert: a user asks in Chat, a platform Agent reads {@link describeKnowledgeProfile}
 * to learn what it must ask for, and only then authors an ordinary Routine bound to this plan.
 */

import type {
  OimKnowledge,
  OimKnowledgeAclEntry,
  OimKnowledgePrincipalKind,
  OimManifest,
  OimOperation,
} from "@tulipfarm/schema";

export type OimKnowledgeCompileErrorCode =
  | "profile_absent"
  | "operation_missing"
  | "operation_not_read_only";

export class OimKnowledgeCompileError extends Error {
  readonly name = "OimKnowledgeCompileError";

  constructor(
    readonly code: OimKnowledgeCompileErrorCode,
    readonly detail: string
  ) {
    super(`oim_knowledge_compile:${code}:${detail}`);
  }
}

/** Effect classes a Knowledge role may name. A sync reads; provider writes stay ordinary Tools. */
const READ_EFFECTS = new Set<OimOperation["effect"]>(["read", "sensitive_read"]);

export interface ResolvedSourceKind {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  /** Present when the provider can list the scopes a user picks from. */
  readonly discover?: {
    readonly operation: OimOperation;
    readonly itemsPointer: string;
    readonly idPointer: string;
    readonly labelPointer: string;
  };
}

export interface ResolvedAclStep {
  readonly mode: "item" | "scope";
  readonly operation: OimOperation;
  /** The request parameter carrying the item id, or the scope, depending on `mode`. */
  readonly parameter?: string;
  readonly parameters?: Readonly<Record<string, string>>;
  readonly entriesPointer: string;
  readonly entry: OimKnowledgeAclEntry;
}

export interface KnowledgeProfilePlan {
  readonly integrationId: string;
  readonly integrationVersion: string;
  readonly majorVersion: number;
  readonly hooks: OimManifest["hooks"];
  readonly sourceKinds: readonly ResolvedSourceKind[];
  readonly list: {
    readonly operation: OimOperation;
    readonly scopeParameter?: string;
    readonly itemsPointer: string;
    readonly mapping: OimKnowledge["list"]["mapping"];
    readonly cursor: OimKnowledge["list"]["cursor"];
    readonly maxPagesPerRun: number;
  };
  readonly content: {
    readonly operation: OimOperation;
    readonly itemParameter?: string;
    readonly parameters?: Readonly<Record<string, string>>;
    readonly mapping: OimKnowledge["content"]["mapping"];
    /** True when the provider treats this content as sensitive, which forbids a cached ACL. */
    readonly sensitive: boolean;
  };
  readonly acl: ResolvedAclStep;
  readonly identity?: {
    readonly user?: {
      readonly operation: OimOperation;
      readonly idParameter: string;
      readonly mapping: {
        readonly providerId: string;
        readonly email?: string;
        readonly emailVerified?: string;
      };
    };
    readonly group?: {
      readonly operation: OimOperation;
      readonly idParameter: string;
      readonly membersPointer?: string;
      readonly mapping: { readonly providerId: string; readonly memberUserId?: string };
    };
  };
  readonly deletion:
    | { readonly kind: "list_flag"; readonly pointer: string }
    | { readonly kind: "absent_from_full_list" }
    | {
        readonly kind: "operation";
        readonly operation: OimOperation;
        readonly scopeParameter?: string;
        readonly parameters?: Readonly<Record<string, string>>;
        readonly itemsPointer: string;
        readonly itemIdPointer: string;
      }
    | { readonly kind: "none" };
  readonly liveAuthorization?: {
    readonly operation: OimOperation;
    readonly itemParameter?: string;
    readonly parameters?: Readonly<Record<string, string>>;
    readonly principalParameter?: string;
    readonly allowedPointer?: string;
    readonly principalSet?: {
      readonly entriesPointer: string;
      readonly principalIdPointer: string;
    };
  };
  readonly guideFile?: string;
}

/**
 * Pages one Run may walk when the manifest sets no bound.
 *
 * A Routine that walks an unbounded source holds its Run open for as long as the provider keeps
 * answering, so the default is a stopping point rather than a limit anyone is expected to hit:
 * the cursor is durable, and the next Run resumes exactly where this one stopped.
 */
export const DEFAULT_KNOWLEDGE_PAGES_PER_RUN = 200;

export function compileKnowledgeProfile(manifest: OimManifest): KnowledgeProfilePlan {
  const knowledge = manifest.knowledge;
  if (!knowledge) {
    throw new OimKnowledgeCompileError("profile_absent", manifest.metadata.id);
  }

  const operations = new Map(manifest.operations.map((operation) => [operation.id, operation]));
  const role = (roleName: string, operationId: string): OimOperation => {
    const operation = operations.get(operationId);
    if (!operation) {
      throw new OimKnowledgeCompileError("operation_missing", `${roleName}:${operationId}`);
    }
    if (!READ_EFFECTS.has(operation.effect)) {
      throw new OimKnowledgeCompileError("operation_not_read_only", `${roleName}:${operationId}`);
    }
    return operation;
  };

  const list = role("list", knowledge.list.operationId);
  const content = role("content", knowledge.content.operationId);
  const acl = role("acl", knowledge.acl.operationId);

  return {
    integrationId: manifest.metadata.id,
    integrationVersion: manifest.metadata.version,
    majorVersion: Number(manifest.metadata.version.split(".")[0]),
    hooks: manifest.hooks,
    sourceKinds: knowledge.sourceKinds.map((kind) => {
      if (kind.discoverOperationId === undefined) {
        return { id: kind.id, label: kind.label, description: kind.description };
      }
      return {
        id: kind.id,
        label: kind.label,
        description: kind.description,
        discover: {
          operation: role(`sourceKinds.${kind.id}.discover`, kind.discoverOperationId),
          itemsPointer: kind.discoverItemsPointer ?? "/items",
          idPointer: kind.discoverMapping?.id ?? "/id",
          labelPointer: kind.discoverMapping?.label ?? "/name",
        },
      };
    }),
    list: {
      operation: list,
      scopeParameter: knowledge.list.scopeParameter,
      itemsPointer: knowledge.list.itemsPointer,
      mapping: knowledge.list.mapping,
      cursor: knowledge.list.cursor,
      maxPagesPerRun: knowledge.list.maxPagesPerRun ?? DEFAULT_KNOWLEDGE_PAGES_PER_RUN,
    },
    content: {
      operation: content,
      itemParameter: knowledge.content.itemParameter,
      parameters: knowledge.content.parameters,
      mapping: knowledge.content.mapping,
      sensitive: content.effect === "sensitive_read",
    },
    acl: {
      mode: knowledge.acl.mode,
      operation: acl,
      parameter:
        knowledge.acl.mode === "item" ? knowledge.acl.itemParameter : knowledge.acl.scopeParameter,
      parameters: knowledge.acl.mode === "item" ? knowledge.acl.parameters : undefined,
      entriesPointer: knowledge.acl.entriesPointer,
      entry: knowledge.acl.entry,
    },
    identity: knowledge.identity
      ? {
          user: knowledge.identity.user
            ? {
                operation: role("identity.user", knowledge.identity.user.operationId),
                idParameter: knowledge.identity.user.idParameter,
                mapping: knowledge.identity.user.mapping,
              }
            : undefined,
          group: knowledge.identity.group
            ? {
                operation: role("identity.group", knowledge.identity.group.operationId),
                idParameter: knowledge.identity.group.idParameter,
                membersPointer: knowledge.identity.group.membersPointer,
                mapping: knowledge.identity.group.mapping,
              }
            : undefined,
        }
      : undefined,
    deletion: compileDeletion(knowledge, role),
    liveAuthorization: knowledge.liveAuthorization
      ? {
          operation: role("liveAuthorization", knowledge.liveAuthorization.operationId),
          itemParameter: knowledge.liveAuthorization.itemParameter,
          parameters: knowledge.liveAuthorization.parameters,
          principalParameter: knowledge.liveAuthorization.principalParameter,
          allowedPointer: knowledge.liveAuthorization.allowedPointer,
          principalSet: knowledge.liveAuthorization.principalSet,
        }
      : undefined,
    guideFile: knowledge.guideFile,
  };
}

function compileDeletion(
  knowledge: OimKnowledge,
  role: (roleName: string, operationId: string) => OimOperation
): KnowledgeProfilePlan["deletion"] {
  const deletion = knowledge.deletion;
  switch (deletion.kind) {
    case "list_flag":
      return { kind: "list_flag", pointer: knowledge.list.mapping.deleted ?? "/deleted" };
    case "absent_from_full_list":
      return { kind: "absent_from_full_list" };
    case "operation":
      return {
        kind: "operation",
        operation: role("deletion", deletion.operationId ?? ""),
        scopeParameter: deletion.scopeParameter,
        parameters: deletion.parameters,
        itemsPointer: deletion.itemsPointer ?? "/items",
        itemIdPointer: deletion.itemIdPointer ?? "/id",
      };
    default:
      return { kind: "none" };
  }
}

export interface KnowledgeProfileChoice {
  readonly id: "source_kind" | "scope" | "connection" | "schedule";
  readonly prompt: string;
  /** Present when the provider can enumerate the answers rather than the user typing one. */
  readonly discoverable?: boolean;
}

export interface KnowledgeProfileDescription {
  readonly integrationId: string;
  readonly sourceKinds: readonly {
    readonly id: string;
    readonly label: string;
    readonly discoverable: boolean;
  }[];
  /** What the Agent must settle with the user before it may author a Routine. */
  readonly requiredChoices: readonly KnowledgeProfileChoice[];
  readonly grantsTo: readonly OimKnowledgePrincipalKind[];
  readonly propagatesDeletions: boolean;
  readonly liveAuthorization: boolean;
  readonly guideFile?: string;
}

/**
 * What a platform Agent needs in order to author an indexing Routine without inventing anything.
 *
 * The choices are listed rather than defaulted on purpose. Picking a Connection or a schedule on
 * the user's behalf is how personal and organization data get indexed into one place, or how a
 * provider bill arrives that nobody agreed to.
 */
export function describeKnowledgeProfile(manifest: OimManifest): KnowledgeProfileDescription {
  const plan = compileKnowledgeProfile(manifest);
  const entry = plan.acl.entry;
  const grantsTo: OimKnowledgePrincipalKind[] = [];
  if (entry.providerUserId !== undefined) grantsTo.push("user");
  if (entry.providerGroupId !== undefined) grantsTo.push("group");
  if (entry.domain !== undefined) grantsTo.push("domain");
  if (entry.kindValues?.public !== undefined || entry.defaultKind === "public") {
    grantsTo.push("public");
  }

  return {
    integrationId: plan.integrationId,
    sourceKinds: plan.sourceKinds.map((kind) => ({
      id: kind.id,
      label: kind.label,
      discoverable: kind.discover !== undefined,
    })),
    requiredChoices: [
      {
        id: "source_kind",
        prompt: `Which kind of ${plan.integrationId} content should be indexed?`,
      },
      {
        id: "scope",
        prompt: "Which specific spaces, folders, channels or labels are in scope?",
        discoverable: plan.sourceKinds.some((kind) => kind.discover !== undefined),
      },
      {
        id: "connection",
        prompt: "Which Connection should the sync use? Personal and organization data never mix.",
      },
      {
        id: "schedule",
        prompt: "How often should it re-sync? Freshness costs provider quota.",
      },
    ],
    grantsTo,
    propagatesDeletions: plan.deletion.kind !== "none",
    liveAuthorization: plan.liveAuthorization !== undefined,
    guideFile: plan.guideFile,
  };
}
