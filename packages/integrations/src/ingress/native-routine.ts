import { canonicalHash, MANUAL_REQUEST_SCHEMA_REF } from "@tulipfarm/schema";
import type {
  NativeChannelInboxRecord,
  NativeChannelInboxStore,
  NativeChannelRoutineRoute,
  Queryable,
  TransactionPort,
} from "@tulipfarm/storage";

type NativeRoutineAuthority = NonNullable<NativeChannelRoutineRoute["authority"]>;

interface NativeRoutineInvocation {
  readonly source: "integration";
  readonly runSource: "routine";
  readonly businessId: string;
  readonly initiator: { readonly kind: "integration"; readonly id: string };
  readonly effectiveSubject: NativeRoutineAuthority["principal"];
  readonly identityMappingEvidenceRef: string;
  readonly definitionRef: string;
  readonly payload: {
    readonly slug: string;
    readonly inputs: {
      readonly event: NativeChannelInboxRecord["payload"];
      readonly nativeChannel: {
        readonly provider: NativeChannelInboxRecord["provider"];
        readonly integrationId: string;
        readonly destination: string;
        readonly eventType: string;
      };
    };
  };
  readonly payloadSchemaRef: typeof MANUAL_REQUEST_SCHEMA_REF;
  readonly idempotencyKey: string;
}

export interface NativeRoutineAdmissionDeps {
  readonly transactions: TransactionPort;
  readonly inbox: Pick<NativeChannelInboxStore, "routineRoutes" | "assertClaim" | "bindRun">;
  readonly authorizeRoutine?: (
    input: Pick<
      NativeChannelRoutineRoute,
      "routineId" | "provider" | "integrationId" | "destination" | "eventType"
    >
  ) => Promise<NativeRoutineAuthority>;
  readonly invocations: {
    start(
      input: NativeRoutineInvocation,
      transaction: Queryable
    ): Promise<{ readonly runId: string }>;
  };
}

export class NativeRoutineAdmissionError extends Error {
  readonly name = "NativeRoutineAdmissionError";

  constructor(readonly code: "native_routine_route_changed" | "native_routine_approval_changed") {
    super(code);
  }
}

/** Accepts a verified, claimed inbox event; the Run and its authority correlation commit together. */
export async function admitNativeRoutine(
  event: NativeChannelInboxRecord,
  deps: NativeRoutineAdmissionDeps
): Promise<string> {
  const pinned = event.binding.routineRoute;
  if (!pinned || typeof pinned !== "object" || !("id" in pinned) || typeof pinned.id !== "string") {
    throw new NativeRoutineAdmissionError("native_routine_route_changed");
  }
  const routeId = pinned.id;
  const current = (await deps.inbox.routineRoutes(event.businessId, event.provider)).find(
    (route) => route.id === routeId && route.enabled && route.integrationId === event.integrationId
  );
  if (
    !current?.authority ||
    canonicalHash(current) !== canonicalHash(pinned) ||
    !deps.authorizeRoutine
  ) {
    throw new NativeRoutineAdmissionError("native_routine_route_changed");
  }
  const authority = await deps.authorizeRoutine(current);
  if (
    canonicalHash(authority) !== canonicalHash(current.authority) ||
    !authority.definitionRef.startsWith("published:routine:")
  ) {
    throw new NativeRoutineAdmissionError("native_routine_approval_changed");
  }
  await deps.inbox.assertClaim(event);
  return deps.transactions.withTransaction(async (transaction) => {
    const result = await deps.invocations.start(
      {
        source: "integration",
        runSource: "routine",
        businessId: event.businessId,
        initiator: { kind: "integration", id: event.integrationId },
        effectiveSubject: authority.principal,
        identityMappingEvidenceRef: `native-channel-inbox:${event.id}`,
        definitionRef: authority.definitionRef,
        payload: {
          slug: authority.definitionRef.slice("published:routine:".length),
          inputs: {
            event: event.payload,
            nativeChannel: {
              provider: event.provider,
              integrationId: event.integrationId,
              destination: current.destination,
              eventType: current.eventType,
            },
          },
        },
        payloadSchemaRef: MANUAL_REQUEST_SCHEMA_REF,
        idempotencyKey: `native:${event.id}`,
      },
      transaction
    );
    await deps.inbox.bindRun(event, result.runId, new Date(), transaction);
    return result.runId;
  });
}
