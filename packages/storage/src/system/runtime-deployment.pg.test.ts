import { PGlite } from "@electric-sql/pglite";
import { expect, it } from "vitest";
import {
  initializeRuntimeDeployment,
  RUNTIME_HOSTING_STORAGE_STATEMENTS,
  RUNTIME_IDENTITY_STORAGE_STATEMENTS,
} from "./runtime-deployment";

it("retains the installation and legacy business identity after closing and reopening storage", async () => {
  const first = await PGlite.create();
  const businessId = "legacy-business";
  const snapshot = await (async () => {
    try {
      for (const statement of [
        ...RUNTIME_IDENTITY_STORAGE_STATEMENTS,
        ...RUNTIME_HOSTING_STORAGE_STATEMENTS,
      ])
        await first.exec(statement);
      const deployment = await initializeRuntimeDeployment(first, { businessId });
      return { deployment, data: await first.dumpDataDir("none") };
    } finally {
      await first.close();
    }
  })();

  const reopened = await PGlite.create({ loadDataDir: snapshot.data });
  try {
    expect(await initializeRuntimeDeployment(reopened, { businessId })).toEqual(
      snapshot.deployment
    );
    await expect(
      initializeRuntimeDeployment(reopened, { businessId: "different-business" })
    ).rejects.toThrow("BUSINESS_ID conflicts");
    expect((await reopened.query("SELECT * FROM deployment_runtime_identity")).rows).toHaveLength(
      1
    );
  } finally {
    await reopened.close();
  }
});
