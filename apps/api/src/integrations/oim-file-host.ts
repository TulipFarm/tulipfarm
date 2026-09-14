import { type AuthorityLayer, decideEffectivePermission } from "@tulipfarm/authz";
import type { FileService } from "@tulipfarm/files";
import type { OimFilePort, OimFileReadAuthorizationPort } from "@tulipfarm/integrations";
import { principalKindOf } from "@tulipfarm/tool-host";
import type { ApiAuthorityLayerResolver } from "../identity/authority-layers";

export interface OimFileAuthorizationInput {
  readonly businessId: string;
  readonly runId: string;
  readonly stateId: string;
  readonly caller: { readonly kind: string; readonly id: string };
  readonly agentPrincipalId?: string;
  readonly fileIds: readonly string[];
}

export interface OimFileHost {
  readonly files: OimFilePort;
  readonly fileReadAuthorization: OimFileReadAuthorizationPort;
  readonly authorizeFiles: (input: OimFileAuthorizationInput) => Promise<void>;
}

export interface OimFileHostOptions {
  readonly files: Pick<FileService, "content" | "upload">;
  readonly runAuthority: {
    authority(
      businessId: string,
      runId: string
    ): Promise<{
      readonly businessId: string;
      readonly runId: string;
      readonly subject: { readonly kind: string; readonly id: string };
    }>;
  };
  readonly authorityLayers: Pick<
    ApiAuthorityLayerResolver,
    "resolveAgentLayer" | "resolvePrincipalLayer"
  >;
  readonly now?: () => Date;
}

export class OimFileAuthorizationError extends Error {
  readonly name = "OimFileAuthorizationError";

  constructor() {
    super("File access is not authorized");
  }
}

function canonicalFileIds(fileIds: readonly string[]): boolean {
  return (
    fileIds.length > 0 &&
    fileIds.every(
      (fileId, index) =>
        fileId.length > 0 && (index === 0 || (fileIds[index - 1] as string) < fileId)
    )
  );
}

function sameFileIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((fileId, index) => fileId === right[index]);
}

export function createOimFileHost(options: OimFileHostOptions): OimFileHost {
  const files: OimFilePort = {
    async content(input) {
      return await options.files.content(input.businessId, input.fileId, input.principalId);
    },
    async store(input) {
      return await options.files.upload(input);
    },
  };
  const authorizeFiles = async (input: OimFileAuthorizationInput): Promise<void> => {
    if (!canonicalFileIds(input.fileIds)) throw new OimFileAuthorizationError();
    let authority: Awaited<ReturnType<OimFileHostOptions["runAuthority"]["authority"]>>;
    try {
      authority = await options.runAuthority.authority(input.businessId, input.runId);
    } catch {
      throw new OimFileAuthorizationError();
    }
    if (
      authority.businessId !== input.businessId ||
      authority.runId !== input.runId ||
      authority.subject.kind !== input.caller.kind ||
      authority.subject.id !== input.caller.id
    ) {
      throw new OimFileAuthorizationError();
    }
    const callerKind = principalKindOf(input.caller.kind);
    if (callerKind === undefined) throw new OimFileAuthorizationError();
    let layers: AuthorityLayer[];
    try {
      const caller = await options.authorityLayers.resolvePrincipalLayer(input.caller.kind, {
        businessId: input.businessId,
        id: input.caller.id,
        kind: callerKind,
      });
      const agent =
        input.agentPrincipalId === undefined
          ? undefined
          : await options.authorityLayers.resolveAgentLayer(
              input.businessId,
              input.agentPrincipalId
            );
      layers = agent === undefined ? [caller] : [caller, agent];
    } catch {
      throw new OimFileAuthorizationError();
    }
    const now = options.now?.() ?? new Date();
    for (const fileId of input.fileIds) {
      if (
        !decideEffectivePermission(
          layers,
          {
            action: "file.read",
            resourceType: "platform.file",
            recordId: fileId,
            dataClass: "operational",
          },
          now
        ).allowed
      ) {
        throw new OimFileAuthorizationError();
      }
    }
  };

  return {
    files,
    authorizeFiles,
    fileReadAuthorization: {
      async assertAuthorized({ request, fileIds }): Promise<void> {
        const { intent } = request;
        if (
          intent.principalKind === undefined ||
          intent.principalId === undefined ||
          intent.filePrincipalId !== intent.principalId ||
          intent.fileIds === undefined ||
          !canonicalFileIds(fileIds) ||
          !sameFileIds(intent.fileIds, fileIds)
        ) {
          throw new OimFileAuthorizationError();
        }
        await authorizeFiles({
          businessId: intent.businessId,
          runId: intent.runId,
          stateId: intent.runStateId ?? intent.stateId,
          caller: { kind: intent.principalKind, id: intent.principalId },
          ...(intent.agentPrincipalId === undefined
            ? {}
            : { agentPrincipalId: intent.agentPrincipalId }),
          fileIds,
        });
      },
    },
  };
}
