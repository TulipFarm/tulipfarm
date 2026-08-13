/**
 * Authoring an access level — the Soul Role behind "Full access", "Everyday access", "Owner".
 *
 * # Why this exists at all
 *
 * Until now `POST /api/v1/authz/roles` answered `501`, telling the caller to "author the Role in
 * Soul instead". That is correct about *where* a Role must live and useless as a product: the only
 * way a business owner could add a fourth access level was to hand-write YAML into a git
 * repository. The three levels the deployment ships with were therefore the three levels that would
 * ever exist, which makes the whole access surface a chooser with no choices.
 *
 * This module keeps the constraint and removes the dead end. Soul stays the single writer of Role
 * definitions — everything here ends as a committed `soul/roles/<slug>/role.yaml`, reviewable in
 * git and reaped by `reconcileSoulRoles` if it is deleted there. What changes is that the product
 * can now *write* that file, the way `soul/skills/tools.ts` writes a Skill and
 * `soul/resource-types/routes.ts` writes a resource type.
 *
 * # Why a level is composed from the capability catalog and not from free text
 *
 * `RoleSchema` will happily accept `action: "integration.create"` — it matches the action pattern.
 * It is also an action that exists nowhere in this codebase, so the grant would match neither an
 * allow nor a deny and the level would silently permit nothing. That exact class of bug (a string
 * composed by a caller that the gate never evaluates) has now been found six times on this surface.
 *
 * So a level is not assembled from strings a caller supplies. The caller names capabilities, and
 * every one must be present in the catalog built from the *live Tool registry* — the same
 * `authorization.action` and `authorization.resources` that `authorizeToolIntent` will later hand
 * to `decideEffectivePermission`. An unknown capability is refused with the list of what was not
 * recognised. A level that cannot grant what it claims can never be written in the first place.
 */

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFINITION_REGISTRATIONS, type RoleDefinition, SchemaRegistry } from "@tulipfarm/schema";
import type { CommitActor, GitSyncService } from "@tulipfarm/soul";
import { stringify as stringifyYaml } from "yaml";
import type { CapabilityCatalog } from "../../authz/capabilities";

const definitionRegistry = new SchemaRegistry(DEFINITION_REGISTRATIONS);

export const LEVEL_SLUG = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export type LevelErrorCode =
  | "invalid_name"
  | "slug_taken"
  | "unknown_capabilities"
  | "no_capabilities"
  | "reserved_slug"
  | "not_found"
  | "invalid_definition";

export class LevelError extends Error {
  readonly code: LevelErrorCode;
  /** The capability ids that were not recognised, when that is the reason. */
  readonly unknown: readonly string[];

  constructor(code: LevelErrorCode, message: string, unknown: readonly string[] = []) {
    super(message);
    this.name = "LevelError";
    this.code = code;
    this.unknown = unknown;
  }
}

/**
 * Slugs a level may not take.
 *
 * `owner`, `admin` and `member` are the bootstrap Roles: `reconcileSoulRoles` refuses to project a
 * Soul Role that collides with one, so a level authored under those names would be written to git,
 * reported as created, and then never take effect — the worst of both outcomes. Refusing up front
 * means the failure is a message the author reads rather than silence they have to notice.
 */
const RESERVED_SLUGS: ReadonlySet<string> = new Set(["owner", "admin", "member"]);

export function slugifyLevelName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export interface LevelInput {
  readonly name: string;
  /** Capability ids (actions) from the catalog. */
  readonly capabilities: readonly string[];
}

export interface LevelDeps {
  readonly gitSync: Pick<GitSyncService, "path" | "withSync">;
  readonly catalog: () => CapabilityCatalog;
  /** Reload the Soul loader and project Roles into durable rows. */
  readonly reconcile: () => Promise<void>;
}

function capabilityIndex(catalog: CapabilityCatalog): Map<string, readonly string[]> {
  const index = new Map<string, readonly string[]>();
  for (const area of catalog.areas) {
    for (const capability of area.capabilities) {
      index.set(capability.id, capability.resourceTypes);
    }
  }
  return index;
}

/**
 * Builds the Role definition for a set of capabilities.
 *
 * One grant per capability rather than one grant listing every action: `compileGrant` takes the
 * cross-product of actions × resource types, so merging two capabilities with different resources
 * into one grant would silently grant each action on the *other* capability's resource too. Keeping
 * them separate makes the compiled rows exactly the pairs that were chosen.
 */
/**
 * Overrides for a definition that is replacing an existing one rather than starting a new level.
 *
 * `slug` is pinned rather than re-derived because renaming a level must not move its artifact: the
 * delete route addresses a level by slug and git history follows the path, so a rename that also
 * moved the directory would read as a delete plus an unrelated create.
 */
export interface LevelOverrides {
  readonly id?: string;
  readonly slug?: string;
  readonly authoredVersion?: number;
}

export function buildLevelDefinition(
  input: LevelInput,
  catalog: CapabilityCatalog,
  overrides: LevelOverrides = {}
): RoleDefinition {
  const name = input.name.trim();
  if (name.length === 0) throw new LevelError("invalid_name", "an access level needs a name");
  const slug = overrides.slug ?? slugifyLevelName(name);
  if (!LEVEL_SLUG.test(slug)) {
    throw new LevelError(
      "invalid_name",
      "a level name must contain at least one letter or number to make a usable name"
    );
  }
  if (RESERVED_SLUGS.has(slug)) {
    throw new LevelError(
      "reserved_slug",
      `"${name}" is the name of a built-in access level — choose another`
    );
  }
  const capabilities = [...new Set(input.capabilities)];
  if (capabilities.length === 0) {
    throw new LevelError(
      "no_capabilities",
      "an access level must allow at least one thing, or it grants nothing"
    );
  }

  const index = capabilityIndex(catalog);
  const unknown = capabilities.filter((capability) => !index.has(capability));
  if (unknown.length > 0) {
    throw new LevelError(
      "unknown_capabilities",
      `these are not things this deployment can grant: ${unknown.join(", ")}`,
      unknown
    );
  }

  const definition: RoleDefinition = {
    apiVersion: "tulipfarm.ai/v1",
    kind: "Role",
    metadata: {
      id: overrides.id ?? randomUUID(),
      slug,
      displayName: name,
      schemaVersion: 1,
      authoredVersion: overrides.authoredVersion ?? 1,
      lifecycle: "active",
    },
    spec: {
      principalTypes: ["user"],
      grants: capabilities.map((action) => ({
        effect: "allow" as const,
        actions: [action],
        // `index.get` cannot be undefined — `unknown` above is empty by this point — but the
        // non-null assertion is banned, and a bare `?? []` would author an empty resource list
        // that the schema then rejects with a message naming the wrong problem.
        resource: { types: [...(index.get(action) ?? [])] },
        delegable: false,
      })),
    },
  };

  // Validate through the same registry the Soul loader uses on read, so a definition that would
  // quarantine the artifact fails here — while the caller is still waiting — rather than after it
  // has been committed to git.
  const validated = definitionRegistry.validateYaml(stringifyYaml(definition));
  if (validated.kind !== "Role") {
    throw new LevelError("invalid_definition", "the generated definition was not a Role");
  }
  return definition;
}

export interface LevelResult {
  readonly id: string;
  readonly slug: string;
  readonly displayName: string;
  readonly capabilities: readonly string[];
}

export async function createLevel(
  input: LevelInput,
  deps: LevelDeps,
  actor?: CommitActor
): Promise<LevelResult> {
  const definition = buildLevelDefinition(input, deps.catalog());
  const slug = definition.metadata.slug;
  const directory = join(deps.gitSync.path, "roles", slug);
  if (existsSync(directory)) {
    throw new LevelError(
      "slug_taken",
      `an access level named "${input.name.trim()}" already exists`
    );
  }

  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "role.yaml"), stringifyYaml(definition), "utf8");
  try {
    await deps.gitSync.withSync(`soul: add access level ${slug}`, actor);
  } catch (error) {
    // The commit is what makes a level real. Leaving the directory behind after a failed commit
    // would make the next attempt fail with "already exists" for a level nobody ever created.
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  await deps.reconcile();

  return {
    id: definition.metadata.id,
    slug,
    displayName: definition.metadata.displayName ?? slug,
    capabilities: definition.spec.grants.flatMap((grant) => grant.actions),
  };
}

/**
 * Replaces a level's name and capabilities in place.
 *
 * The identity is deliberately preserved: `metadata.id` is what `compileRoleDefinition` uses as the
 * durable row id, and every assignment — to a person and to a team — points at that row. Minting a
 * fresh id would make an edit indistinguishable from a delete followed by a create, silently
 * revoking the level from everybody who held it. The slug is preserved for the same reason the id
 * is, and because git history follows the path.
 *
 * `authoredVersion` counts edits, so a reviewer reading the artifact can tell a level that has been
 * revised from one that has not.
 */
export async function updateLevel(
  slug: string,
  input: LevelInput,
  deps: LevelDeps,
  actor?: CommitActor
): Promise<LevelResult> {
  if (!LEVEL_SLUG.test(slug)) {
    throw new LevelError("not_found", `no access level named "${slug}"`);
  }
  if (RESERVED_SLUGS.has(slug)) {
    throw new LevelError("reserved_slug", "a built-in access level cannot be changed");
  }
  const directory = join(deps.gitSync.path, "roles", slug);
  const file = join(directory, "role.yaml");
  if (!existsSync(file)) {
    throw new LevelError("not_found", `no access level named "${slug}"`);
  }

  const previous = await readFile(file, "utf8");
  const current = definitionRegistry.validateYaml(previous);
  if (current.kind !== "Role") {
    throw new LevelError("invalid_definition", `"${slug}" is not an access level`);
  }
  const metadata = (current.document as unknown as RoleDefinition).metadata;

  const definition = buildLevelDefinition(input, deps.catalog(), {
    id: metadata.id,
    slug,
    authoredVersion: metadata.authoredVersion + 1,
  });

  await writeFile(file, stringifyYaml(definition), "utf8");
  try {
    await deps.gitSync.withSync(`soul: update access level ${slug}`, actor);
  } catch (error) {
    // Put back exactly what was there. Without this a failed commit leaves the working tree
    // carrying an edit nobody accepted, which the next unrelated commit would sweep up.
    await writeFile(file, previous, "utf8");
    throw error;
  }
  await deps.reconcile();

  return {
    id: definition.metadata.id,
    slug,
    displayName: definition.metadata.displayName ?? slug,
    capabilities: definition.spec.grants.flatMap((grant) => grant.actions),
  };
}

export async function deleteLevel(
  slug: string,
  deps: LevelDeps,
  actor?: CommitActor
): Promise<void> {
  // Validated before the path is built, not after. `slug` arrives from a URL parameter, so without
  // this `../../` walks straight out of the Soul repository and `rm -r` deletes whatever it lands
  // on. It also stops an arbitrary file in `roles/` — a README, a stray note — being treated as a
  // level merely because `existsSync` returns true for it.
  if (!LEVEL_SLUG.test(slug)) {
    throw new LevelError("not_found", `no access level named "${slug}"`);
  }
  if (RESERVED_SLUGS.has(slug)) {
    throw new LevelError("reserved_slug", "a built-in access level cannot be deleted");
  }
  const directory = join(deps.gitSync.path, "roles", slug);
  if (!existsSync(join(directory, "role.yaml"))) {
    throw new LevelError("not_found", `no access level named "${slug}"`);
  }
  await rm(directory, { recursive: true, force: true });
  await deps.gitSync.withSync(`soul: remove access level ${slug}`, actor);
  // `reconcileSoulRoles` reaps the durable row, which cascades to every assignment of it — that is
  // what deleting a level means, and why the route requires an explicit confirmation.
  await deps.reconcile();
}
