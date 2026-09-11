import type { PersistedRun, RunStore } from "@tulipfarm/storage";
import type { FastifyRequest } from "fastify";
import type { AuthorizationCheck } from "../authz/route-gate";
import type { RequestPrincipal } from "../identity/principal";
import type { RunStreamGrant } from "./events";

/** The immutable initiator also covers old attempts after a retry replaces the Turn's Run id. */
function isParticipant(run: PersistedRun | null, principal: RequestPrincipal): boolean {
  return (
    run?.source === "chat" &&
    run.businessId === principal.businessId &&
    principal.kind === "user" &&
    run.identity.initiator.kind === principal.kind &&
    run.identity.initiator.id === principal.id
  );
}

export function runAuthorizers(runs: Pick<RunStore, "find">, check: AuthorizationCheck) {
  const read = async (req: FastifyRequest, runId: string): Promise<RunStreamGrant | null> => {
    const principal = req.principal;
    if (!principal) return null;
    const operator = await check(principal, {
      action: "operations.read",
      resourceType: "operations",
      fallback: "admin",
    });
    if (!operator && !isParticipant(await runs.find(principal.businessId, runId), principal)) {
      return null;
    }
    return {
      businessId: principal.businessId,
      audiences: operator ? ["participant", "operator"] : ["participant"],
    };
  };
  return {
    read,
    cancel: async (req: FastifyRequest, runId: string) => {
      const principal = req.principal;
      return (
        principal !== undefined &&
        isParticipant(await runs.find(principal.businessId, runId), principal)
      );
    },
  };
}
