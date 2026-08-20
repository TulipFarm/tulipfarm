import type { AccessGrant } from "./grants";

/** One resource type and the actions on it a catalog entry speaks for. */
export interface RoleSurface {
  readonly type: string;
  readonly actions: readonly string[];
}

/** Compiles a surface catalog into grants of one effect, one grant per named action. */
export function surfaceGrants(
  surfaces: readonly RoleSurface[],
  effect: AccessGrant["effect"]
): AccessGrant[] {
  return surfaces.flatMap((surface) =>
    surface.actions.map((action): AccessGrant => ({ action, resourceType: surface.type, effect }))
  );
}

/**
 * The denies an allow-listed role needs so its own broad allows cannot reach a restricted action.
 *
 * A blanket `deny` on every restricted action reads safer than it is: a Role's grants all land in
 * one authority layer and deny beats allow there, so a role carrying those denies could never be
 * lifted by *any* Role granted on top of it (#408). A restricted action is already unreachable by
 * default deny, so the only denies worth keeping are the ones compensating for an allow that would
 * otherwise reach it — a same-type wildcard, an exact same-action allow, or `alwaysDenied`, which
 * covers a residual `resourceType: "*"` allow the caller holds outside this catalog.
 */
export function restrictedSurfaceCarveOut(
  restricted: readonly RoleSurface[],
  allowed: readonly RoleSurface[],
  alwaysDenied: readonly string[] = []
): AccessGrant[] {
  return restricted.flatMap((surface) => {
    const allowedActions = allowed
      .filter((entry) => entry.type === surface.type)
      .flatMap((entry) => entry.actions);
    const denied = new Set<string>(alwaysDenied);
    for (const action of surface.actions) {
      if (allowedActions.includes("*") || allowedActions.includes(action)) denied.add(action);
    }
    return [...denied].map(
      (action): AccessGrant => ({ action, resourceType: surface.type, effect: "deny" })
    );
  });
}
