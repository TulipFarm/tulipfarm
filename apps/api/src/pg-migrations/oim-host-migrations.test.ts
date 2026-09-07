import {
  OIM_RATE_LIMIT_STORAGE_STATEMENTS,
  OIM_RELEASE_MAINTENANCE_STORAGE_STATEMENTS,
  OIM_RELEASE_TRUST_STORAGE_STATEMENTS,
} from "@tulipfarm/storage";
import { describe, expect, it, vi } from "vitest";
import { PG_MIGRATIONS } from "./index";

describe("OIM host migrations", () => {
  it("adds maintenance configuration without changing the release trust migration", () => {
    expect(OIM_RELEASE_TRUST_STORAGE_STATEMENTS.join("\n")).not.toContain(
      "oim_release_maintenance_config"
    );
    expect(OIM_RELEASE_MAINTENANCE_STORAGE_STATEMENTS.join("\n")).toContain(
      "CREATE TABLE IF NOT EXISTS oim_release_maintenance_config"
    );
  });

  it.each([
    { version: 107, statements: OIM_RATE_LIMIT_STORAGE_STATEMENTS },
    { version: 108, statements: OIM_RELEASE_TRUST_STORAGE_STATEMENTS },
    { version: 109, statements: OIM_RELEASE_MAINTENANCE_STORAGE_STATEMENTS },
  ])("installs migration $version through the boot registry", async ({ version, statements }) => {
    const migration = PG_MIGRATIONS.find((entry) => entry.version === version);
    if (migration === undefined) throw new Error(`OIM migration ${version} is not registered`);
    const query = vi.fn().mockResolvedValue({ rows: [] });

    await migration.up({ query });

    expect(query.mock.calls.map(([statement]) => statement)).toEqual(statements);
  });
});
