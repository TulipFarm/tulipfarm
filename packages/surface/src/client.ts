import { isRecord } from "@tulipfarm/schema";
/** Browser-safe Surface helpers; keep this entry point free of TypeBox and Ajv imports. */
import { canonicalHash } from "@tulipfarm/schema/canonicalize";

import {
  SURFACE_ACTION_EVENT_MAX_LENGTH,
  SURFACE_ACTION_EVENT_MIN_LENGTH,
  SURFACE_ACTION_EVENT_PATTERN,
  SURFACE_ACTION_KEYS,
} from "./action-constraints";

import type {
  PresentationContext,
  SurfaceAction,
  SurfaceArtifact,
  SurfaceChannel,
  SurfaceClassification,
  SurfaceComponentDefinition,
  SurfaceComponentSupport,
  SurfaceInteraction,
  SurfaceRenderContext,
  SurfaceRenderer,
  SurfaceRendererManifest,
  SurfaceRenderIssue,
  SurfaceTarget,
} from "./contracts";
import type { FormSubmissionResult, GovernedForm, SubmitFormInput } from "./forms";
import type { ResolvedSurfaceViewNode } from "./soul";

export type {
  FormSubmissionResult,
  GovernedForm,
  PresentationContext,
  ResolvedSurfaceViewNode,
  SubmitFormInput,
  SurfaceAction,
  SurfaceArtifact,
  SurfaceChannel,
  SurfaceClassification,
  SurfaceComponentDefinition,
  SurfaceComponentSupport,
  SurfaceInteraction,
  SurfaceRenderContext,
  SurfaceRenderer,
  SurfaceRendererManifest,
  SurfaceRenderIssue,
  SurfaceTarget,
};

const SURFACE_ACTION_KEY_SET = new Set<string>(SURFACE_ACTION_KEYS);
const SURFACE_ACTION_EVENT_REGEX = new RegExp(SURFACE_ACTION_EVENT_PATTERN);

function isSurfaceAction(value: unknown): value is SurfaceAction {
  if (!isRecord(value)) return false;
  if (!Object.keys(value).every((key) => SURFACE_ACTION_KEY_SET.has(key))) return false;
  if (
    typeof value.event !== "string" ||
    value.event.length < SURFACE_ACTION_EVENT_MIN_LENGTH ||
    value.event.length > SURFACE_ACTION_EVENT_MAX_LENGTH ||
    !SURFACE_ACTION_EVENT_REGEX.test(value.event)
  ) {
    return false;
  }
  if ("payload" in value && value.payload !== undefined && !isRecord(value.payload)) return false;
  if ("disabled" in value && value.disabled !== undefined && typeof value.disabled !== "boolean") {
    return false;
  }
  return !("stepUp" in value && value.stepUp !== undefined && typeof value.stepUp !== "boolean");
}

export function surfaceActionKey(action: SurfaceAction): string {
  return canonicalHash({
    event: action.event,
    payload: action.payload ?? {},
    stepUp: action.stepUp ?? false,
  });
}

export function surfaceActionsForArtifact(artifact: SurfaceArtifact): readonly SurfaceAction[] {
  const props = artifact.props as Record<string, unknown>;
  if (artifact.component.name === "Choices") {
    const action = props.action;
    const choices = props.choices;
    if (!isSurfaceAction(action) || !Array.isArray(choices)) return [];
    return [
      action,
      ...choices.flatMap((choice) => {
        if (typeof choice !== "object" || choice === null || !("value" in choice)) return [];
        return [{ ...action, payload: { ...action.payload, value: choice.value } }];
      }),
    ];
  }

  const actions: SurfaceAction[] = [];
  const visit = (value: unknown): void => {
    if (isSurfaceAction(value)) {
      actions.push(value);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (typeof value !== "object" || value === null) return;
    Object.values(value).forEach(visit);
  };
  visit(props);
  return actions;
}

export function targetKey(target: SurfaceTarget): string {
  return `${target.channel}/${target.surface}`;
}

export function sameTarget(left: SurfaceTarget, right: SurfaceTarget): boolean {
  return left.channel === right.channel && left.surface === right.surface;
}
