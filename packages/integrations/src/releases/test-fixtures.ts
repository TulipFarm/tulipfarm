import type { OimManifest, OimPackageContent } from "@tulipfarm/schema";
import { oimFileDigest } from "@tulipfarm/schema";

export function releasePackageFixture(
  options: {
    readonly integrationId?: string;
    readonly version?: string;
    readonly files?: Readonly<Record<string, OimPackageContent>>;
  } = {}
) {
  const files = options.files ?? {};
  const manifest: OimManifest = {
    oimVersion: "1.0",
    kind: "Integration",
    metadata: {
      id: options.integrationId ?? "weather",
      name: "Weather",
      version: options.version ?? "1.2.3",
      description: "Read current weather.",
      license: "Apache-2.0",
    },
    profiles: { core: "1.0" },
    ...(Object.keys(files).length === 0
      ? {}
      : {
          files: Object.entries(files).map(([path, content]) => ({
            path,
            role: path.endsWith(".md") ? ("guide" as const) : ("fixture" as const),
            sha256: oimFileDigest(content),
          })),
        }),
    operations: [
      {
        id: "current-weather",
        name: "current_weather",
        description: "Read current weather.",
        effect: "read",
        identityMode: "shared_only",
        source: {
          type: "http",
          method: "GET",
          baseUrl: "https://api.weather.example",
          path: "/v1/current",
        },
        response: {
          schema: { type: "object" },
          maxBytes: 16_384,
        },
      },
    ],
  };
  return {
    manifest,
    files: new Map(Object.entries(files)),
  };
}
