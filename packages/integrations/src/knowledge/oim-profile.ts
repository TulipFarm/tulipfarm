import type {
  OimKnowledge,
  OimKnowledgeAclEntry,
  OimKnowledgePrincipalBody,
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

const READ_EFFECTS = new Set<OimOperation["effect"]>(["read", "sensitive_read"]);

export interface KnowledgeProfilePlan {
  readonly integrationId: string;
  readonly integrationVersion: string;
  readonly majorVersion: number;
  readonly sourceKinds: readonly {
    readonly id: string;
    readonly label: string;
    readonly description?: string;
    readonly discover?: {
      readonly operation: OimOperation;
      readonly itemsPointer: string;
      readonly idPointer: string;
      readonly labelPointer: string;
    };
  }[];
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
    readonly sensitive: boolean;
  };
  readonly acl: {
    readonly mode: "item" | "scope";
    readonly operation: OimOperation;
    readonly parameter?: string;
    readonly parameters?: Readonly<Record<string, string>>;
    readonly entriesPointer: string;
    readonly entry: OimKnowledgeAclEntry;
  };
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
    readonly principalBody?: OimKnowledgePrincipalBody;
    readonly allowedPointer?: string;
    readonly principalSet?: {
      readonly entriesPointer: string;
      readonly principalIdPointer: string;
    };
  };
  readonly guideFile?: string;
}

export const DEFAULT_KNOWLEDGE_PAGES_PER_RUN = 200;

export function compileKnowledgeProfile(manifest: OimManifest): KnowledgeProfilePlan {
  const knowledge = manifest.knowledge;
  if (knowledge === undefined) {
    throw new OimKnowledgeCompileError("profile_absent", manifest.metadata.id);
  }
  const operations = new Map(manifest.operations.map((operation) => [operation.id, operation]));
  const role = (name: string, operationId: string): OimOperation => {
    const operation = operations.get(operationId);
    if (operation === undefined) {
      throw new OimKnowledgeCompileError("operation_missing", `${name}:${operationId}`);
    }
    if (!READ_EFFECTS.has(operation.effect)) {
      throw new OimKnowledgeCompileError("operation_not_read_only", `${name}:${operationId}`);
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
    sourceKinds: knowledge.sourceKinds.map((kind) => ({
      id: kind.id,
      label: kind.label,
      ...(kind.description === undefined ? {} : { description: kind.description }),
      ...(kind.discoverOperationId === undefined
        ? {}
        : {
            discover: {
              operation: role(`sourceKinds.${kind.id}.discover`, kind.discoverOperationId),
              itemsPointer: kind.discoverItemsPointer ?? "/items",
              idPointer: kind.discoverMapping?.id ?? "/id",
              labelPointer: kind.discoverMapping?.label ?? "/name",
            },
          }),
    })),
    list: {
      operation: list,
      ...(knowledge.list.scopeParameter === undefined
        ? {}
        : { scopeParameter: knowledge.list.scopeParameter }),
      itemsPointer: knowledge.list.itemsPointer,
      mapping: knowledge.list.mapping,
      cursor: knowledge.list.cursor,
      maxPagesPerRun: knowledge.list.maxPagesPerRun ?? DEFAULT_KNOWLEDGE_PAGES_PER_RUN,
    },
    content: {
      operation: content,
      ...(knowledge.content.itemParameter === undefined
        ? {}
        : { itemParameter: knowledge.content.itemParameter }),
      ...(knowledge.content.parameters === undefined
        ? {}
        : { parameters: knowledge.content.parameters }),
      mapping: knowledge.content.mapping,
      sensitive: content.effect === "sensitive_read",
    },
    acl: {
      mode: knowledge.acl.mode,
      operation: acl,
      parameter:
        knowledge.acl.mode === "item" ? knowledge.acl.itemParameter : knowledge.acl.scopeParameter,
      ...(knowledge.acl.mode === "item" && knowledge.acl.parameters !== undefined
        ? { parameters: knowledge.acl.parameters }
        : {}),
      entriesPointer: knowledge.acl.entriesPointer,
      entry: knowledge.acl.entry,
    },
    ...(knowledge.identity === undefined
      ? {}
      : {
          identity: {
            ...(knowledge.identity.user === undefined
              ? {}
              : {
                  user: {
                    operation: role("identity.user", knowledge.identity.user.operationId),
                    idParameter: knowledge.identity.user.idParameter,
                    mapping: knowledge.identity.user.mapping,
                  },
                }),
            ...(knowledge.identity.group === undefined
              ? {}
              : {
                  group: {
                    operation: role("identity.group", knowledge.identity.group.operationId),
                    idParameter: knowledge.identity.group.idParameter,
                    ...(knowledge.identity.group.membersPointer === undefined
                      ? {}
                      : { membersPointer: knowledge.identity.group.membersPointer }),
                    mapping: knowledge.identity.group.mapping,
                  },
                }),
          },
        }),
    deletion: compileDeletion(knowledge, role),
    ...(knowledge.liveAuthorization === undefined
      ? {}
      : {
          liveAuthorization: {
            operation: role("liveAuthorization", knowledge.liveAuthorization.operationId),
            ...(knowledge.liveAuthorization.itemParameter === undefined
              ? {}
              : { itemParameter: knowledge.liveAuthorization.itemParameter }),
            ...(knowledge.liveAuthorization.parameters === undefined
              ? {}
              : { parameters: knowledge.liveAuthorization.parameters }),
            ...(knowledge.liveAuthorization.principalParameter === undefined
              ? {}
              : { principalParameter: knowledge.liveAuthorization.principalParameter }),
            ...(knowledge.liveAuthorization.principalBody === undefined
              ? {}
              : { principalBody: knowledge.liveAuthorization.principalBody }),
            ...(knowledge.liveAuthorization.allowedPointer === undefined
              ? {}
              : { allowedPointer: knowledge.liveAuthorization.allowedPointer }),
            ...(knowledge.liveAuthorization.principalSet === undefined
              ? {}
              : { principalSet: knowledge.liveAuthorization.principalSet }),
          },
        }),
    ...(knowledge.guideFile === undefined ? {} : { guideFile: knowledge.guideFile }),
  };
}

function compileDeletion(
  knowledge: OimKnowledge,
  role: (name: string, operationId: string) => OimOperation
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
        ...(deletion.scopeParameter === undefined
          ? {}
          : { scopeParameter: deletion.scopeParameter }),
        ...(deletion.parameters === undefined ? {} : { parameters: deletion.parameters }),
        itemsPointer: deletion.itemsPointer ?? "/items",
        itemIdPointer: deletion.itemIdPointer ?? "/id",
      };
    default:
      return { kind: "none" };
  }
}

export interface KnowledgeProfileDescription {
  readonly integrationId: string;
  readonly sourceKinds: readonly {
    readonly id: string;
    readonly label: string;
    readonly discoverable: boolean;
  }[];
  readonly requiredChoices: readonly {
    readonly id: "source_kind" | "scope" | "connection" | "schedule";
    readonly prompt: string;
    readonly discoverable?: boolean;
  }[];
  readonly grantsTo: readonly OimKnowledgePrincipalKind[];
  readonly propagatesDeletions: boolean;
  readonly liveAuthorization: boolean;
  readonly guideFile?: string;
}

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
    ...(plan.guideFile === undefined ? {} : { guideFile: plan.guideFile }),
  };
}
