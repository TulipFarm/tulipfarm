import type { OimManifest } from "@tulipfarm/schema";
import { oimFileDigest } from "@tulipfarm/schema";
import { describe, expect, it } from "vitest";
import { runOimFixtures } from "./oim-fixtures";

const fixture = `version: 1
cases:
  - name: gets-weather
    operationId: get-weather
    request:
      city: London
    response:
      status: 200
      body:
        temperature: 18
    expect:
      request:
        method: GET
        url: https://api.weather.example/weather?city=London
      result:
        temperature: 18
`;

function manifest(content = fixture): OimManifest {
  return {
    oimVersion: "1.0",
    kind: "Integration",
    metadata: {
      id: "weather",
      name: "Weather",
      version: "1.0.0",
      description: "Weather.",
      license: "Apache-2.0",
    },
    profiles: { core: "1.0" },
    files: [{ path: "fixtures.yml", role: "fixture", sha256: oimFileDigest(content) }],
    operations: [
      {
        id: "get-weather",
        name: "get_weather",
        description: "Get weather.",
        effect: "read",
        identityMode: "shared_only",
        source: {
          type: "http",
          method: "GET",
          baseUrl: "https://api.weather.example",
          path: "/weather",
          parameters: [{ name: "city", in: "query", schema: { type: "string" } }],
        },
        response: { maxBytes: 1024, schema: { type: "object" } },
      },
    ],
  } as OimManifest;
}

describe("runOimFixtures", () => {
  it("runs the compiled adapter against the recorded response and checks its request shape", async () => {
    await expect(runOimFixtures(manifest(), new Map([["fixtures.yml", fixture]]))).resolves.toEqual(
      [{ name: "gets-weather", fixture: "fixtures.yml", passed: true }]
    );
  });

  it("refuses a fixture that asks for a real credential, clock, or network capability", async () => {
    const unsafe = fixture.replace(
      "operationId: get-weather",
      "operationId: get-weather\n    clock: now"
    );

    await expect(
      runOimFixtures(manifest(unsafe), new Map([["fixtures.yml", unsafe]]))
    ).resolves.toEqual([
      expect.objectContaining({
        name: "fixtures.yml",
        passed: false,
        error: expect.stringContaining("fixture gets-weather refuses clock"),
      }),
    ]);
  });
});
