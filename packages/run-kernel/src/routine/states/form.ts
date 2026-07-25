import { TypedOutputError, type TypedOutputValidator } from "../../outputs";
import type { RegisterWaitInput } from "../../waits";
import type { CompiledState } from "../compiler";
import { RoutineStepError } from "./step";
import {
  continueState,
  planStateWait,
  resolveErrorPath,
  type StateResumeDecision,
  type StateWaitContext,
} from "./wait-plan";

export interface FormWaitContext extends StateWaitContext {
  /** Canonical principals allowed to submit. A form is never open to "whoever has the link". */
  readonly principals: readonly string[];
}

export function planFormWait(state: CompiledState, ctx: FormWaitContext): RegisterWaitInput {
  return planStateWait(state, ctx, { kind: "form", principals: ctx.principals });
}

/**
 * Validate a submission against the State's own declared output schema before the Run continues.
 * A form State with no declared schema is a denial rather than an unvalidated pass-through, and a
 * schema failure never echoes the submitted value — it may carry protected data.
 */
export function resolveFormSubmission(
  state: CompiledState,
  validator: TypedOutputValidator,
  submission: unknown
): StateResumeDecision {
  const schemaRef = state.outputSchemaRef;
  if (schemaRef === null) throw new RoutineStepError("output_schema_not_declared", state.name);

  try {
    validator.validate(schemaRef, submission);
  } catch (error) {
    if (error instanceof TypedOutputError) return resolveErrorPath(state, "form_invalid", "failed");
    throw error;
  }
  return continueState(state);
}

/** An unanswered form is nobody's decision: park it for attention. */
export function resolveFormExpiry(state: CompiledState): StateResumeDecision {
  return resolveErrorPath(state, "wait_expired", "attention");
}
