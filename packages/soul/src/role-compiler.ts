import type { AccessGrant, Role as AuthzRole } from "@tulipfarm/authz";
import type { RoleDefinition, RoleGrant } from "@tulipfarm/schema";
import type { GrantRecord, RoleRecord } from "@tulipfarm/storage";
import type { SoulRole } from "./types";

export type SoulRoleCompileErrorCode =
  | "INVALID_EXPIRY"
  | "UNSUPPORTED_AUDIENCE"
  | "UNSUPPORTED_CONDITION";

export class SoulRoleCompileError extends Error {
  readonly code: SoulRoleCompileErrorCode;
  readonly roleId: string;
  readonly grantIndex: number;

  constructor(code: SoulRoleCompileErrorCode, roleId: string, grantIndex: number, message: string) {
    super(message);
    this.name = "SoulRoleCompileError";
    this.code = code;
    this.roleId = roleId;
    this.grantIndex = grantIndex;
  }
}

export type CompiledSoulGrant = GrantRecord & AccessGrant;
export type CompiledSoulRole = Omit<RoleRecord, "grants"> &
  Omit<AuthzRole, "grants"> & {
    readonly grants: readonly CompiledSoulGrant[];
  };

function dimension<T>(values: readonly T[] | undefined): readonly (T | undefined)[] {
  return values === undefined ? [undefined] : values;
}

function expiresAt(
  roleId: string,
  grantIndex: number,
  value: string | undefined
): Date | undefined {
  if (value === undefined) return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) {
    throw new SoulRoleCompileError(
      "INVALID_EXPIRY",
      roleId,
      grantIndex,
      `Role ${roleId} grant ${grantIndex} has an invalid expiry`
    );
  }
  return parsed;
}

function conditions(
  roleId: string,
  grantIndex: number,
  grant: RoleGrant
): Readonly<Record<string, string>> | undefined {
  if (grant.conditions === undefined) return undefined;
  const compiled: Record<string, string> = {};
  for (const condition of grant.conditions) {
    if (condition.operator !== "equals" || typeof condition.value !== "string") {
      throw new SoulRoleCompileError(
        "UNSUPPORTED_CONDITION",
        roleId,
        grantIndex,
        `Role ${roleId} grant ${grantIndex} has a condition the authz grant row cannot express`
      );
    }
    if (compiled[condition.attribute] !== undefined) {
      throw new SoulRoleCompileError(
        "UNSUPPORTED_CONDITION",
        roleId,
        grantIndex,
        `Role ${roleId} grant ${grantIndex} repeats condition ${condition.attribute}`
      );
    }
    compiled[condition.attribute] = condition.value;
  }
  return Object.freeze(compiled);
}

function compileGrant(roleId: string, grant: RoleGrant, grantIndex: number): CompiledSoulGrant[] {
  if (grant.audiences !== undefined) {
    throw new SoulRoleCompileError(
      "UNSUPPORTED_AUDIENCE",
      roleId,
      grantIndex,
      `Role ${roleId} grant ${grantIndex} has audiences the authz grant row cannot express`
    );
  }

  // `resource` is required by `RoleGrantSchema`, so a validated grant always names its types. The
  // fallback that used to stand here (`?? ["*"]`) was an unbounded-authority bypass: it turned an
  // omitted selector into the wildcard the schema refuses to let anyone write. Compilation is the
  // last place that could reintroduce it, so it does not.
  const resourceTypes = grant.resource.types;
  const recordSelectors = dimension(grant.resource.recordIds);
  const domains = dimension(grant.domains);
  const dataClasses = dimension(grant.dataClasses);
  const destinations = dimension(grant.destinations);
  const compiledConditions = conditions(roleId, grantIndex, grant);
  const grantExpiresAt = expiresAt(roleId, grantIndex, grant.expiresAt);
  const grants: CompiledSoulGrant[] = [];

  for (const action of grant.actions) {
    for (const resourceType of resourceTypes) {
      for (const recordSelector of recordSelectors) {
        for (const domain of domains) {
          for (const dataClass of dataClasses) {
            for (const destination of destinations) {
              grants.push(
                Object.freeze({
                  action,
                  resourceType,
                  ...(domain === undefined ? {} : { domain }),
                  ...(recordSelector === undefined ? {} : { recordSelector }),
                  ...(grant.fields === undefined ? {} : { fieldSelector: [...grant.fields] }),
                  ...(dataClass === undefined ? {} : { dataClass }),
                  ...(destination === undefined ? {} : { destination }),
                  ...(compiledConditions === undefined ? {} : { conditions: compiledConditions }),
                  effect: grant.effect,
                  ...(grantExpiresAt === undefined ? {} : { expiresAt: grantExpiresAt }),
                })
              );
            }
          }
        }
      }
    }
  }

  return grants;
}

export function compileRoleDefinition(
  definition: RoleDefinition,
  businessId: string
): CompiledSoulRole {
  const roleId = definition.metadata.id;
  return Object.freeze({
    id: roleId,
    businessId,
    assignableTo: Object.freeze([...definition.spec.principalTypes]),
    parentRoleIds: Object.freeze([...(definition.spec.inherits ?? [])]),
    grants: Object.freeze(
      definition.spec.grants.flatMap((grant, index) => compileGrant(roleId, grant, index))
    ),
  });
}

export function compileSoulRole(role: SoulRole, businessId: string): CompiledSoulRole {
  return compileRoleDefinition(role.definition, businessId);
}

export function compileSoulRoles(
  roles: Iterable<SoulRole>,
  businessId: string
): CompiledSoulRole[] {
  return [...roles].map((role) => compileSoulRole(role, businessId));
}
