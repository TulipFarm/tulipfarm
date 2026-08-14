/** Compile Guardrails only when exact: unsupported scope, constraints, or redact are refused. */

import type { GuardrailDefinition } from "@tulipfarm/schema";
import type { GuardrailEffect } from "./decision";
import type { DlpRule } from "./dlp";
import type { GuardrailRule } from "./engine";

export type GuardrailPolicyRefusalCode =
  | "unsupported_condition"
  | "unsupported_constraint"
  | "unsupported_dlp_action"
  | "unsupported_expiry";

/** Payload-safe refusal naming the authored rule that could not be compiled exactly. */
export class GuardrailPolicyError extends Error {
  readonly name = "GuardrailPolicyError";

  constructor(
    readonly code: GuardrailPolicyRefusalCode,
    readonly ruleId: string
  ) {
    super(`${code}:${ruleId}`);
  }
}

export interface GuardrailPolicy {
  readonly rules: readonly GuardrailRule[];
  readonly dlpRules: readonly DlpRule[];
}

type AuthoredRule = GuardrailDefinition["spec"]["rules"][number];
type ScopedAuthoredRule = Extract<AuthoredRule, { type: "allow" | "deny" }>;
type AuthoredScope = NonNullable<AuthoredRule["scope"]>;
type AuthoredConstraints = NonNullable<AuthoredRule["constraints"]>;

/** `undefined` for "unscoped", so an expansion over it yields exactly one unscoped rule. */
function dimension(values: readonly string[] | undefined): readonly (string | undefined)[] {
  return values === undefined || values.length === 0 ? [undefined] : values;
}

function assertScopeSupported(rule: AuthoredRule): void {
  const scope: AuthoredScope | undefined = rule.scope;
  if (scope === undefined) return;
  if (scope.conditions !== undefined) {
    throw new GuardrailPolicyError("unsupported_condition", rule.id);
  }
  if (scope.expiresAt !== undefined) throw new GuardrailPolicyError("unsupported_expiry", rule.id);
}

/**
 * The record ceiling this rule carries, if any. Every other constraint is refused: a ceiling the
 * engine cannot check is a ceiling nothing checks.
 */
function recordCeiling(rule: AuthoredRule): number | undefined {
  const constraints: AuthoredConstraints | undefined = rule.constraints;
  if (constraints === undefined) return undefined;
  const { maxRecords, ...rest } = constraints;
  for (const value of Object.values(rest)) {
    if (value !== undefined) throw new GuardrailPolicyError("unsupported_constraint", rule.id);
  }
  return maxRecords;
}

interface ExpansionScope {
  /** Actions the rule covers; a `dlp` rule names none, so it covers every action. */
  readonly actions?: readonly string[];
  readonly dataClasses?: readonly string[];
  readonly destinations?: readonly string[];
  readonly audiences?: readonly string[];
  readonly fieldSelector?: readonly string[];
}

/** One `GuardrailRule` per authored combination; ids stay the authored id, never a payload. */
function expand(
  rule: AuthoredRule,
  effect: GuardrailEffect,
  scope: ExpansionScope
): GuardrailRule[] {
  assertScopeSupported(rule);
  // Read on every path so an unsupported constraint is refused even where the engine would
  // ignore the ceiling it carries.
  const ceiling = recordCeiling(rule);
  const maxRecordCount = effect === "allow" ? ceiling : undefined;

  const resource = rule.scope?.resource;
  const fieldSelector = scope.fieldSelector ?? resource?.fields;
  const rules: GuardrailRule[] = [];

  for (const action of scope.actions ?? ["*"]) {
    for (const resourceType of dimension(resource?.types)) {
      for (const recordSelector of dimension(resource?.recordIds)) {
        for (const dataClass of dimension(scope.dataClasses)) {
          for (const destination of dimension(scope.destinations)) {
            for (const audience of dimension(scope.audiences)) {
              rules.push({
                id: rule.id,
                effect,
                action,
                resourceType: resourceType ?? "*",
                ...(recordSelector === undefined ? {} : { recordSelector }),
                ...(fieldSelector === undefined ? {} : { fieldSelector }),
                ...(dataClass === undefined ? {} : { dataClass }),
                ...(destination === undefined ? {} : { destination }),
                ...(audience === undefined ? {} : { audience }),
                ...(maxRecordCount === undefined ? {} : { maxRecordCount }),
              });
            }
          }
        }
      }
    }
  }
  return rules;
}

/** DLP permits an authored `allow` grants: one per data class it names. */
function permits(rule: ScopedAuthoredRule): DlpRule[] {
  return (rule.dataClasses ?? []).map((dataClass) => ({
    dataClass,
    ...(rule.destinations === undefined ? {} : { allowedDestinations: rule.destinations }),
    ...(rule.audiences === undefined ? {} : { allowedAudiences: rule.audiences }),
  }));
}

function compileDlp(rule: Extract<AuthoredRule, { type: "dlp" }>): GuardrailRule[] {
  if (rule.action === "redact") {
    throw new GuardrailPolicyError("unsupported_dlp_action", rule.id);
  }
  const effect: GuardrailEffect = rule.action === "block" ? "deny" : "require_approval";
  const rules: GuardrailRule[] = [];

  for (const detector of rule.detectors) {
    // A flagged secret is denied by `checkDlpBoundary` before any rule is read, so a `secret`
    // detector needs nothing here — and expressing it as a rule would weaken that default.
    if (detector.type === "secret") continue;
    const scope: ExpansionScope = {
      destinations: rule.destinations,
      audiences: rule.audiences,
      ...(detector.type === "dataClass"
        ? { dataClasses: detector.values }
        : { fieldSelector: detector.values }),
    };
    rules.push(...expand(rule, effect, scope));
  }
  return rules;
}

/** Compiles authored Guardrails in order; engine precedence makes final decisions stable. */
export function compileGuardrailPolicy(
  definitions: readonly GuardrailDefinition[]
): GuardrailPolicy {
  const rules: GuardrailRule[] = [];
  const dlpRules: DlpRule[] = [];

  for (const definition of definitions) {
    for (const rule of definition.spec.rules) {
      switch (rule.type) {
        case "allow":
          rules.push(
            ...expand(rule, "allow", {
              actions: rule.actions,
              dataClasses: rule.dataClasses,
              destinations: rule.destinations,
              audiences: rule.audiences,
            })
          );
          dlpRules.push(...permits(rule));
          break;
        case "deny":
          rules.push(
            ...expand(rule, "deny", {
              actions: rule.actions,
              dataClasses: rule.dataClasses,
              destinations: rule.destinations,
              audiences: rule.audiences,
            })
          );
          break;
        case "approval":
          rules.push(...expand(rule, "require_approval", { actions: rule.actions }));
          break;
        default:
          rules.push(...compileDlp(rule));
      }
    }
  }

  return { rules, dlpRules };
}
