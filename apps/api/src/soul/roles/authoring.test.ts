/** Access-level authoring tests focus on refusals that would otherwise save but grant nothing. */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CapabilityCatalog } from "../../authz/capabilities";
import {
  buildLevelDefinition,
  createLevel,
  deleteLevel,
  LevelError,
  slugifyLevelName,
  updateLevel,
} from "./authoring";

const CATALOG: CapabilityCatalog = {
  areas: [
    {
      id: "github",
      label: "GitHub",
      capabilities: [
        {
          id: "github.issue.create",
          action: "github.issue.create",
          resourceTypes: ["integration.github"],
          label: "Add issue",
          changesThings: true,
          tools: ["github_issue_create"],
        },
        {
          id: "github.issue.list",
          action: "github.issue.list",
          resourceTypes: ["integration.github"],
          label: "See issue",
          changesThings: false,
          tools: ["github_issue_list"],
        },
      ],
    },
    {
      id: "record",
      label: "Records",
      capabilities: [
        {
          id: "record.read",
          action: "record.read",
          resourceTypes: ["record"],
          label: "See record",
          changesThings: false,
          tools: ["record_get"],
        },
      ],
    },
  ],
  unavailable: [],
};

const ID = "3f5fa2a1-0df5-469a-a161-816fd4e6ad89";

describe("slugifyLevelName", () => {
  it.each([
    ["Kitchen staff", "kitchen-staff"],
    ["  Front of House  ", "front-of-house"],
    ["Accounts & Payroll", "accounts-payroll"],
  ])("turns %s into %s", (name, expected) => {
    expect(slugifyLevelName(name)).toBe(expected);
  });
});

describe("buildLevelDefinition", () => {
  it("writes one grant per capability, naming the resources the gate will check", () => {
    const definition = buildLevelDefinition(
      { name: "Support", capabilities: ["github.issue.create", "record.read"] },
      CATALOG,
      { id: ID }
    );
    expect(definition.spec.grants).toEqual([
      {
        effect: "allow",
        actions: ["github.issue.create"],
        resource: { types: ["integration.github"] },
        delegable: false,
      },
      {
        effect: "allow",
        actions: ["record.read"],
        resource: { types: ["record"] },
        delegable: false,
      },
    ]);
    expect(definition.metadata).toMatchObject({ id: ID, slug: "support", displayName: "Support" });
  });

  /*
   * `compileGrant` takes the cross-product of actions × resource types. Merging two capabilities
   * into one grant would therefore grant each action on the *other* capability's resource as well —
   * a silent widening of exactly the kind least privilege exists to prevent.
   */
  it("never merges capabilities with different resources into one grant", () => {
    const definition = buildLevelDefinition(
      { name: "Mixed", capabilities: ["github.issue.create", "record.read"] },
      CATALOG,
      { id: ID }
    );
    for (const grant of definition.spec.grants) {
      expect(grant.actions).toHaveLength(1);
    }
  });

  it("refuses a capability this deployment cannot grant, and names it", () => {
    expect(() =>
      buildLevelDefinition(
        { name: "Bad", capabilities: ["github.issue.create", "integration.create"] },
        CATALOG,
        { id: ID }
      )
    ).toThrowError(
      expect.objectContaining({ code: "unknown_capabilities", unknown: ["integration.create"] })
    );
  });

  it("refuses a level that allows nothing", () => {
    expect(() =>
      buildLevelDefinition({ name: "Empty", capabilities: [] }, CATALOG, { id: ID })
    ).toThrow(LevelError);
  });

  it("refuses a name that produces no usable slug", () => {
    expect(() =>
      buildLevelDefinition({ name: "!!!", capabilities: ["record.read"] }, CATALOG, { id: ID })
    ).toThrowError(expect.objectContaining({ code: "invalid_name" }));
  });

  /*
   * `reconcileSoulRoles` skips a Soul Role colliding with a bootstrap id. Allowing the name would
   * write the artifact, commit it, report success, and never take effect.
   */
  it.each(["Owner", "admin", "Member"])("refuses the built-in name %s", (name) => {
    expect(() =>
      buildLevelDefinition({ name, capabilities: ["record.read"] }, CATALOG, { id: ID })
    ).toThrowError(expect.objectContaining({ code: "reserved_slug" }));
  });

  it("does not grant the same capability twice when it is chosen twice", () => {
    const definition = buildLevelDefinition(
      { name: "Dupes", capabilities: ["record.read", "record.read"] },
      CATALOG,
      { id: ID }
    );
    expect(definition.spec.grants).toHaveLength(1);
  });
});

describe("createLevel and deleteLevel", () => {
  let soulPath: string;
  let withSync: ReturnType<typeof vi.fn>;
  let reconcile: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    soulPath = await mkdtemp(join(tmpdir(), "tf-levels-"));
    withSync = vi.fn(async () => undefined);
    reconcile = vi.fn(async () => undefined);
  });

  afterEach(async () => {
    await rm(soulPath, { recursive: true, force: true });
  });

  function deps() {
    return {
      gitSync: { path: soulPath, withSync } as never,
      catalog: () => CATALOG,
      reconcile: reconcile as unknown as () => Promise<void>,
    };
  }

  it("writes the artifact, commits it, then projects it", async () => {
    const level = await createLevel(
      { name: "Kitchen staff", capabilities: ["record.read"] },
      deps()
    );

    expect(level.slug).toBe("kitchen-staff");
    expect(level.displayName).toBe("Kitchen staff");
    const written = await readFile(join(soulPath, "roles", "kitchen-staff", "role.yaml"), "utf8");
    expect(written).toContain("kind: Role");
    expect(written).toContain("record.read");
    expect(withSync).toHaveBeenCalledOnce();
    // Order matters: projecting before the commit would leave a durable row with no artifact
    // behind it, which the next reconcile would reap.
    expect(withSync.mock.invocationCallOrder[0]).toBeLessThan(
      reconcile.mock.invocationCallOrder[0] ?? 0
    );
  });

  it("refuses a level whose name is already taken", async () => {
    await createLevel({ name: "Kitchen", capabilities: ["record.read"] }, deps());
    await expect(
      createLevel({ name: "kitchen", capabilities: ["record.read"] }, deps())
    ).rejects.toThrowError(expect.objectContaining({ code: "slug_taken" }));
  });

  /*
   * A directory left behind by a failed commit makes the *next* attempt fail with "already
   * exists" for a level that was never created — an error the owner cannot act on, about a level
   * they cannot see.
   */
  it("leaves nothing behind when the commit fails", async () => {
    withSync.mockRejectedValueOnce(new Error("git is unhappy"));
    await expect(
      createLevel({ name: "Doomed", capabilities: ["record.read"] }, deps())
    ).rejects.toThrow("git is unhappy");

    await expect(
      readFile(join(soulPath, "roles", "doomed", "role.yaml"), "utf8")
    ).rejects.toThrow();
    expect(reconcile).not.toHaveBeenCalled();
  });

  it("writes nothing at all when a capability is not grantable", async () => {
    await expect(
      createLevel({ name: "Bad", capabilities: ["nope.nothing"] }, deps())
    ).rejects.toThrowError(expect.objectContaining({ code: "unknown_capabilities" }));
    expect(withSync).not.toHaveBeenCalled();
  });

  it("deletes a level, commits, and reprojects", async () => {
    await createLevel({ name: "Temp", capabilities: ["record.read"] }, deps());
    withSync.mockClear();

    await deleteLevel("temp", deps());

    await expect(readFile(join(soulPath, "roles", "temp", "role.yaml"), "utf8")).rejects.toThrow();
    expect(withSync).toHaveBeenCalledOnce();
    expect(reconcile).toHaveBeenCalledTimes(2);
  });

  it("refuses to delete a built-in level", async () => {
    await expect(deleteLevel("owner", deps())).rejects.toThrowError(
      expect.objectContaining({ code: "reserved_slug" })
    );
    expect(withSync).not.toHaveBeenCalled();
  });

  it("reports a level that does not exist rather than committing an empty change", async () => {
    await expect(deleteLevel("ghost", deps())).rejects.toThrowError(
      expect.objectContaining({ code: "not_found" })
    );
    expect(withSync).not.toHaveBeenCalled();
  });

  /*
   * The catalog is read per call, not captured: declarative integration Tools appear and disappear
   * as integrations connect. A level authored a moment after an integration connects must be able
   * to use it.
   */
  it("reads the catalog at the moment of the call", async () => {
    let catalog: CapabilityCatalog = { areas: [], unavailable: [] };
    const live = {
      gitSync: { path: soulPath, withSync } as never,
      catalog: () => catalog,
      reconcile: reconcile as unknown as () => Promise<void>,
    };
    await expect(
      createLevel({ name: "Early", capabilities: ["record.read"] }, live)
    ).rejects.toThrowError(expect.objectContaining({ code: "unknown_capabilities" }));

    catalog = CATALOG;
    await expect(
      createLevel({ name: "Later", capabilities: ["record.read"] }, live)
    ).resolves.toMatchObject({ slug: "later" });
  });

  it("does not treat an unrelated file in the roles directory as a level", async () => {
    await createLevel({ name: "Real", capabilities: ["record.read"] }, deps());
    await writeFile(join(soulPath, "roles", "README.md"), "notes", "utf8");
    await expect(deleteLevel("README.md", deps())).rejects.toThrowError(
      expect.objectContaining({ code: "not_found" })
    );
  });
});

/** Editing must preserve durable role ids and existing assignments. */
describe("updateLevel", () => {
  let soulPath: string;
  let withSync: ReturnType<typeof vi.fn>;
  let reconcile: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    soulPath = await mkdtemp(join(tmpdir(), "tf-levels-edit-"));
    withSync = vi.fn(async () => undefined);
    reconcile = vi.fn(async () => undefined);
  });

  afterEach(async () => {
    await rm(soulPath, { recursive: true, force: true });
  });

  function deps() {
    return {
      gitSync: { path: soulPath, withSync } as never,
      catalog: () => CATALOG,
      reconcile: reconcile as unknown as () => Promise<void>,
    };
  }

  it("keeps the identity so existing assignments survive the edit", async () => {
    const created = await createLevel({ name: "Kitchen", capabilities: ["record.read"] }, deps());

    const updated = await updateLevel(
      "kitchen",
      { name: "Kitchen", capabilities: ["record.read", "github.issue.create"] },
      deps()
    );

    expect(updated.id).toBe(created.id);
    expect(updated.capabilities).toEqual(
      expect.arrayContaining(["record.read", "github.issue.create"])
    );
  });

  it("keeps the slug when the name changes", async () => {
    await createLevel({ name: "Kitchen", capabilities: ["record.read"] }, deps());

    const updated = await updateLevel(
      "kitchen",
      { name: "Kitchen crew", capabilities: ["record.read"] },
      deps()
    );

    expect(updated.slug).toBe("kitchen");
    expect(updated.displayName).toBe("Kitchen crew");
    const written = await readFile(join(soulPath, "roles", "kitchen", "role.yaml"), "utf8");
    expect(written).toContain("Kitchen crew");
  });

  it("counts the edit so a revised level is distinguishable from an untouched one", async () => {
    await createLevel({ name: "Kitchen", capabilities: ["record.read"] }, deps());
    await updateLevel(
      "kitchen",
      { name: "Kitchen", capabilities: ["github.issue.create"] },
      deps()
    );

    const written = await readFile(join(soulPath, "roles", "kitchen", "role.yaml"), "utf8");
    expect(written).toContain("authoredVersion: 2");
  });

  it("commits before projecting", async () => {
    await createLevel({ name: "Kitchen", capabilities: ["record.read"] }, deps());
    withSync.mockClear();
    reconcile.mockClear();

    await updateLevel(
      "kitchen",
      { name: "Kitchen", capabilities: ["github.issue.create"] },
      deps()
    );

    expect(withSync).toHaveBeenCalledOnce();
    expect(withSync.mock.invocationCallOrder[0]).toBeLessThan(
      reconcile.mock.invocationCallOrder[0] ?? 0
    );
  });

  /*
   * A failed commit must not leave an edit nobody accepted sitting in the working tree, where the
   * next unrelated commit would sweep it up.
   */
  it("puts the previous artifact back when the commit fails", async () => {
    await createLevel({ name: "Kitchen", capabilities: ["record.read"] }, deps());
    const before = await readFile(join(soulPath, "roles", "kitchen", "role.yaml"), "utf8");
    withSync.mockRejectedValueOnce(new Error("git is unhappy"));

    await expect(
      updateLevel("kitchen", { name: "Kitchen", capabilities: ["github.issue.create"] }, deps())
    ).rejects.toThrow("git is unhappy");

    const after = await readFile(join(soulPath, "roles", "kitchen", "role.yaml"), "utf8");
    expect(after).toBe(before);
  });

  it("refuses to edit a built-in level", async () => {
    await expect(
      updateLevel("owner", { name: "Owner", capabilities: ["record.read"] }, deps())
    ).rejects.toThrowError(expect.objectContaining({ code: "reserved_slug" }));
    expect(withSync).not.toHaveBeenCalled();
  });

  it("reports a level that does not exist", async () => {
    await expect(
      updateLevel("ghost", { name: "Ghost", capabilities: ["record.read"] }, deps())
    ).rejects.toThrowError(expect.objectContaining({ code: "not_found" }));
    expect(withSync).not.toHaveBeenCalled();
  });

  it("writes nothing when a capability is not grantable", async () => {
    await createLevel({ name: "Kitchen", capabilities: ["record.read"] }, deps());
    const before = await readFile(join(soulPath, "roles", "kitchen", "role.yaml"), "utf8");
    withSync.mockClear();

    await expect(
      updateLevel("kitchen", { name: "Kitchen", capabilities: ["nope.nothing"] }, deps())
    ).rejects.toThrowError(expect.objectContaining({ code: "unknown_capabilities" }));

    expect(await readFile(join(soulPath, "roles", "kitchen", "role.yaml"), "utf8")).toBe(before);
    expect(withSync).not.toHaveBeenCalled();
  });

  /*
   * `slug` reaches this function from a URL parameter and is joined into a filesystem path, same
   * as in `deleteLevel`. Validation must come before the join.
   */
  it("refuses a slug that would leave the roles directory", async () => {
    for (const slug of ["../../etc", "..", "a/../../b", "%2e%2e"]) {
      await expect(
        updateLevel(slug, { name: "X", capabilities: ["record.read"] }, deps())
      ).rejects.toThrowError(expect.objectContaining({ code: "not_found" }));
    }
    expect(withSync).not.toHaveBeenCalled();
  });
});

/** URL slugs are attacker-controlled path input before recursive delete. */
describe("deleteLevel refuses to leave the roles directory", () => {
  let soulPath: string;
  let withSync: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    soulPath = await mkdtemp(join(tmpdir(), "tf-levels-esc-"));
    withSync = vi.fn(async () => undefined);
  });

  afterEach(async () => {
    await rm(soulPath, { recursive: true, force: true });
  });

  it.each([
    "../..",
    "../../etc",
    "..",
    "a/../../b",
    "/etc",
    "sub/dir",
  ])("refuses %s without touching the filesystem", async (slug) => {
    const outside = join(soulPath, "keep-me.txt");
    await writeFile(outside, "important", "utf8");

    await expect(
      deleteLevel(slug, {
        gitSync: { path: join(soulPath, "soul"), withSync } as never,
        catalog: () => CATALOG,
        reconcile: async () => undefined,
      })
    ).rejects.toThrowError(expect.objectContaining({ code: "not_found" }));

    await expect(readFile(outside, "utf8")).resolves.toBe("important");
    expect(withSync).not.toHaveBeenCalled();
  });
});
