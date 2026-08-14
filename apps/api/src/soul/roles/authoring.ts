/**
 * Authoring an access level — the Soul Role behind "Full access", "Everyday access", "Owner". # Why
 * this exists at all Until now `POST /api/v1/authz/roles` answered `501`, telling the caller to
 * "author the Role in Soul instead". That is correct about *where* a Role must live and useless as
 * a product: the only way a business owner could add a fourth access level was to hand-write YAML
 * into a git repository. Soul stays the single writer of Role definitions — everything here ends as
 * a committed `soul/roles/<slug>/role.yaml`, reviewable in git and reaped by `reconcileSoulRoles`
 * if it is deleted there.
 */

import { randomUUID } from "node:crypto";
import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import { DEFINITION_REGISTRATIONS, type RoleDefinition, SchemaRegistry } from "@tulipfarm/schema";
import {
  type CommitActor,
  type SoulPrecondition,
  type SoulWrite,
  SoulWriteError,
  type SoulWriter,
} from "@tulipfarm/soul";
import { stringify as stringifyYaml } from "yaml";
import type { CapabilityCatalog } from "../../authz/capabilities";
import { SYSTEM_SOUL_COMMIT_ACTOR } from "../../runtime/soul-writer";

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
  readonly unknown: readonly string[];

  constructor(code: LevelErrorCode, message: string, unknown: readonly string[] = []) {
    super(message);
    this.name = "LevelError";
    this.code = code;
    this.unknown = unknown;
  }
}

/**
 * Slugs a level may not take. `owner`, `admin` and `member` are the bootstrap Roles:
 * `reconcileSoulRoles` refuses to project a Soul Role that collides with one, so a level authored
 * under those names would be written to git, reported as created, and then never take effect — the
 * worst of both outcomes. Refusing up front means the failure is a message the author reads rather
 * than silence they have to notice.
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
  readonly capabilities: readonly string[];
}

export interface LevelDeps {
  /** The ADR-007 write gateway: reads, existence checks, and atomic commits all go through it. */
  readonly soulWriter: Pick<SoulWriter, "exists" | "read" | "apply">;
  readonly catalog: () => CapabilityCatalog;
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
 * Overrides for a definition that is replacing an existing one rather than starting a new level.
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
        resource: { types: [...(index.get(action) ?? [])] },
        delegable: false,
      })),
    },
  };

  // quarantine the artifact fails here — while the caller is still waiting — rather than after it
  const validated = definitionRegistry.validateYaml(stringifyYaml(definition));
  if (validated.kind !== "Role") {
    throw new LevelError("invalid_definition", "the generated definition was not a Role");
  }
  return definition;
}

/**
 * Commit a level change through the write gateway, translating its failures into this module's
 * error vocabulary. `CONFLICT` is reported as `not_found`'s sibling rather than swallowed: the
 * caller computed the definition from a tree that has since moved, so the edit must be recomputed
 * rather than retried with the same bytes.
 */
async function applyLevelWrite(
  deps: LevelDeps,
  write: {
    subject: string;
    changes: readonly SoulWrite[];
    preconditions: readonly SoulPrecondition[];
  },
  actor?: CommitActor
): Promise<void> {
  try {
    await deps.soulWriter.apply({
      subject: write.subject,
      source: "api",
      actor: actor ?? SYSTEM_SOUL_COMMIT_ACTOR,
      businessId: DEPLOYMENT_BUSINESS_ID,
      changes: write.changes,
      preconditions: write.preconditions,
    });
  } catch (error) {
    if (error instanceof SoulWriteError) throw levelErrorFor(error);
    throw error;
  }
}

function levelErrorFor(error: SoulWriteError): LevelError {
  switch (error.code) {
    case "PRECONDITION_FAILED":
      return new LevelError("not_found", "the access level changed before this edit was saved");
    case "VALIDATION_FAILED":
      return new LevelError("invalid_definition", "the generated definition was not a valid Role");
    case "CONFLICT":
      return new LevelError(
        "invalid_definition",
        "another change landed first; reopen the access level and try again"
      );
    default:
      return new LevelError("invalid_definition", "the access level could not be saved");
  }
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
  if (deps.soulWriter.exists("Role", slug)) {
    throw new LevelError(
      "slug_taken",
      `an access level named "${input.name.trim()}" already exists`
    );
  }

  // No hand-rolled rollback: the changeset either commits whole or leaves the tree untouched, so
  // a failed write cannot strand a directory that makes the next attempt report "already exists".
  await applyLevelWrite(
    deps,
    {
      subject: `soul: add access level ${slug}`,
      changes: [{ op: "put", target: { kind: "Role", slug }, content: stringifyYaml(definition) }],
      preconditions: [{ kind: "Role", slug, state: "absent" }],
    },
    actor
  );
  await deps.reconcile();

  return {
    id: definition.metadata.id,
    slug,
    displayName: definition.metadata.displayName ?? slug,
    capabilities: definition.spec.grants.flatMap((grant) => grant.actions),
  };
}

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
  const previous = deps.soulWriter.read("Role", slug);
  if (previous === null) {
    throw new LevelError("not_found", `no access level named "${slug}"`);
  }
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

  await applyLevelWrite(
    deps,
    {
      subject: `soul: update access level ${slug}`,
      changes: [{ op: "put", target: { kind: "Role", slug }, content: stringifyYaml(definition) }],
      preconditions: [{ kind: "Role", slug, state: "present" }],
    },
    actor
  );
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
  if (!LEVEL_SLUG.test(slug)) {
    throw new LevelError("not_found", `no access level named "${slug}"`);
  }
  if (RESERVED_SLUGS.has(slug)) {
    throw new LevelError("reserved_slug", "a built-in access level cannot be deleted");
  }
  if (!deps.soulWriter.exists("Role", slug)) {
    throw new LevelError("not_found", `no access level named "${slug}"`);
  }
  await applyLevelWrite(
    deps,
    {
      subject: `soul: remove access level ${slug}`,
      changes: [{ op: "deleteArtifact", kind: "Role", slug }],
      preconditions: [{ kind: "Role", slug, state: "present" }],
    },
    actor
  );
  await deps.reconcile();
}
