import { OIM_PROFILE_VERSION_MATRIX } from "@oim-standard/conformance";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerOimCapabilitiesRoute } from "./oim-capabilities";

describe("GET /api/v1/system/oim-capabilities", () => {
  it("is protected and reports only runtime-verified profiles", async () => {
    const app = Fastify();
    registerOimCapabilitiesRoute(app, { runtimeVersion: "test" }, async (request, reply) => {
      if (request.headers.authorization !== "Bearer test") {
        await reply.code(401).send({ error: "unauthorized" });
      }
    });
    await app.ready();

    const unauthorized = await app.inject({
      method: "GET",
      url: "/api/v1/system/oim-capabilities",
    });
    expect(unauthorized.statusCode).toBe(401);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/system/oim-capabilities",
      headers: { authorization: "Bearer test" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      capabilities: {
        packageEntrypoint: "oim.yml",
        runtime: { name: "TulipFarm", version: "test" },
        profiles: { core: ["1.0", "1.1", "1.2"] },
      },
      unverifiedProfiles: [
        {
          profile: "auth",
          versions: OIM_PROFILE_VERSION_MATRIX.auth,
          reason: "conformance_not_run",
        },
        {
          profile: "events",
          versions: OIM_PROFILE_VERSION_MATRIX.events,
          reason: "conformance_not_run",
        },
        {
          profile: "knowledge",
          versions: OIM_PROFILE_VERSION_MATRIX.knowledge,
          reason: "conformance_not_run",
        },
        {
          profile: "hooks",
          versions: OIM_PROFILE_VERSION_MATRIX.hooks,
          reason: "conformance_not_run",
        },
      ],
    });
  });
});
