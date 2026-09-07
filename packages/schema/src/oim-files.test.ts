import type { OimManifest } from "@tulipfarm/schema";
import { describe, expect, it } from "vitest";
import { oimManifestIssues, validateOimManifest } from "./oim";

function manifest(): OimManifest {
  return {
    oimVersion: "1.0",
    kind: "Integration",
    metadata: {
      id: "drive",
      name: "Drive",
      version: "1.0.0",
      description: "Stores files.",
      license: "Apache-2.0",
    },
    profiles: { core: "1.2" },
    operations: [
      {
        id: "upload",
        name: "upload_file",
        description: "Upload one File.",
        effect: "create",
        identityMode: "shared_only",
        source: {
          type: "http",
          method: "POST",
          baseUrl: "https://api.drive.example",
          path: "/files",
          contentType: "multipart",
          multipart: {
            parts: [
              { name: "metadata", kind: "field", pointer: "/metadata", maxBytes: 1024 },
              { name: "file", kind: "file", pointer: "/fileId" },
            ],
          },
        },
        requestSchema: {
          type: "object",
          properties: {
            metadata: { type: "object" },
            fileId: { type: "string" },
          },
          required: ["metadata", "fileId"],
          additionalProperties: false,
        },
        response: { mode: "binary", maxBytes: 1024 },
      },
    ],
  };
}

describe("OIM Core 1.2 file operations", () => {
  it("accepts bounded multipart File ids and binary responses", () => {
    expect(validateOimManifest(manifest())).toEqual(manifest());
    expect(oimManifestIssues(manifest())).toEqual([]);
  });

  it("requires Core 1.2 and keeps multipart declarations bounded", () => {
    const legacy = manifest();
    legacy.profiles.core = "1.1";
    expect(oimManifestIssues(legacy)).toContain(
      'profiles: core "1.2" is required for response.mode: binary, source.contentType: multipart, source.multipart'
    );

    const unbound = manifest();
    if (unbound.operations[0]?.source.type !== "http") throw new Error("fixture");
    delete unbound.operations[0].source.multipart;
    expect(oimManifestIssues(unbound)).toContain(
      "operations: upload multipart content type requires declared parts"
    );
  });
});
