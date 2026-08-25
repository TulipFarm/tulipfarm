import type { StartSubagentRun } from "@tulipfarm/agent-runtime";
import {
  type DurableInvocationGateway,
  INVOKE_STATE_KEY,
  RUN_EXECUTOR_PRINCIPAL_REF,
  requestArtifactId,
  SUBAGENT_RUN_SOURCE,
} from "@tulipfarm/run-kernel";
import { SUBAGENT_REQUEST_SCHEMA_REF } from "@tulipfarm/schema";

/**
 * A sub-agent runs no Soul artifact, but the invocation gateway refuses an unpublished definition
 * ref outright. This names the platform capability itself rather than a Soul Agent, which is
 * accurate: what was published is the ability to spawn a helper, not any particular helper.
 */
const SUBAGENT_DEFINITION_REF = "published:platform:subagent";

export interface SubagentRunDeps {
  readonly invocations: DurableInvocationGateway;
}

/**
 * Mints an ad-hoc sub-agent Run through the only Run-minting door there is.
 *
 * No Conversation is created, so nothing appears in the sidebar and nothing is added to any
 * transcript. The helper's whole input is the request Artifact published here, which is also what
 * the API reads back when it assembles the helper's Context.
 */
export function startSubagentRun(deps: SubagentRunDeps): StartSubagentRun {
  return async (input) => {
    // The helper acts as the spawning Agent, not as whoever prompted it: initiator and effective
    // subject must match or the invocation gateway refuses identity substitution.
    const principal = {
      kind: "agent",
      id: input.persona.name,
      businessId: input.businessId,
    } as const;

    const started = await deps.invocations.start({
      // How the invocation arrived, not what runs it: a sub-agent is spawned from inside a Turn,
      // which is the same origin a delegated child Run records.
      source: "chat",
      runSource: SUBAGENT_RUN_SOURCE,
      businessId: input.businessId,
      initiator: principal,
      effectiveSubject: principal,
      definitionRef: SUBAGENT_DEFINITION_REF,
      payloadSchemaRef: SUBAGENT_REQUEST_SCHEMA_REF,
      payload: {
        persona: { name: input.persona.name, instructions: input.persona.instructions },
        task: input.task,
        ...(input.context === undefined ? {} : { context: input.context }),
        parentRunId: input.parentRunId,
        parentCallId: input.callId,
        // Binds the helper to its spawner's capability restrictions and autonomy. Without it the
        // helper resolves to the default assistant, which is wider than the Agent that spawned it.
        ...(input.parentAgentId === undefined ? {} : { agentId: input.parentAgentId }),
        // What the helper is *offered*. The child link written after this is what bounds it, and
        // the Context resolver intersects the two — so a name that survives here still cannot
        // reach a Tool the link withheld.
        ...(input.authority.tools.length === 0 ? {} : { toolNames: [...input.authority.tools] }),
      },
      // The spawning Tool call is what makes this idempotent: it is stable across a replay,
      // whereas a fresh Run id would mint a second helper every time the parent resumed.
      idempotencyKey: `subagent:${input.parentRunId}:${input.callId}`,
    });

    return { childRunId: started.runId };
  };
}

/** Republishes nothing; exported for the composition root to name the same id the Worker uses. */
export function subagentRequestArtifactId(runId: string): string {
  return requestArtifactId(runId);
}

export { INVOKE_STATE_KEY, RUN_EXECUTOR_PRINCIPAL_REF };
