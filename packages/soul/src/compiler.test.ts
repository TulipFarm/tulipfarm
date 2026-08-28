import type { VersionedSchemaDocument } from "@tulipfarm/schema";
import { describe, expect, it } from "vitest";
import { BundleError, type BundleErrorCode, computeBundleDigest } from "./bundle";
import {
  compileExecutionBundle,
  MAX_BUNDLE_ASSET_BYTES,
  MAX_BUNDLE_TOTAL_ASSET_BYTES,
} from "./compiler";

const API = "tulipfarm.ai/v1";

function def(
  kind: string,
  slug: string,
  spec: Record<string, unknown>,
  extra: { id?: string; authoredVersion?: number } = {}
): VersionedSchemaDocument {
  return {
    apiVersion: API,
    kind,
    metadata: {
      id: extra.id ?? `id-${kind}-${slug}`,
      slug,
      schemaVersion: 1,
      authoredVersion: extra.authoredVersion ?? 1,
      lifecycle: "published",
    },
    spec,
  } as unknown as VersionedSchemaDocument;
}

function request(documents: readonly VersionedSchemaDocument[]) {
  return {
    businessId: "biz-1",
    changesetId: "cs-1",
    commitSha: "c0ffee",
    documents,
  };
}

/** Catch and return the thrown bundle error, or fail if nothing was thrown. */
function failure(fn: () => void): BundleError {
  try {
    fn();
  } catch (error) {
    if (error instanceof BundleError) return error;
    throw error;
  }
  throw new Error("expected BundleError");
}

function model(slug: string, authoredVersion = 1): VersionedSchemaDocument {
  return def("ModelProfile", slug, { provider: "p", model: "m" }, { authoredVersion });
}

function largeText(bytes: number): string {
  return "x".repeat(bytes);
}

describe("compileExecutionBundle", () => {
  it("resolves every reference to an exact version", () => {
    const bundle = compileExecutionBundle(
      request([
        model("fast", 4),
        def("Routine", "intake", {
          start: "s1",
          states: [{ name: "s1", type: "agent", agentRef: { name: "triage", version: "latest" } }],
        }),
        def("Agent", "triage", { modelProfile: "fast", skills: [] }, { authoredVersion: 7 }),
      ])
    );

    const routine = bundle.definitions.find((d) => d.kind === "Routine");
    expect(routine?.references).toEqual([
      {
        field: "/spec/states/0/agentRef",
        kind: "Agent",
        id: "id-Agent-triage",
        slug: "triage",
        authoredVersion: 7,
      },
    ]);
    const agent = bundle.definitions.find((d) => d.kind === "Agent");
    expect(agent?.references).toEqual([
      {
        field: "/spec/modelProfile",
        kind: "ModelProfile",
        id: "id-ModelProfile-fast",
        slug: "fast",
        authoredVersion: 4,
      },
    ]);
  });

  it("orders definitions deterministically and pins each authored version", () => {
    const documents = [model("b"), def("Agent", "a", { skills: [] }, { authoredVersion: 3 })];
    const bundle = compileExecutionBundle(request(documents));
    expect(bundle.definitions.map((d) => `${d.kind}:${d.slug}@${d.authoredVersion}`)).toEqual([
      "Agent:a@3",
      "ModelProfile:b@1",
    ]);
    expect(bundle.commitSha).toBe("c0ffee");
    expect(bundle.bundleVersion).toBe(2);
  });

  it("keeps live authority definitions in the signed bundle distribution", () => {
    const bundle = compileExecutionBundle(
      request([
        def(
          "Role",
          "ops-reviewer",
          {
            principalTypes: ["user"],
            grants: [],
          },
          { id: "11111111-1111-1111-1111-111111111111" }
        ),
        def(
          "AccessGrant",
          "github-support",
          {
            integrationId: "22222222-2222-2222-2222-222222222222",
            principals: [{ kind: "user", id: "33333333-3333-3333-3333-333333333333" }],
            actions: ["github.read"],
            externalTargets: [{ type: "github.repository", ids: ["maddhruv/tulipfarm"] }],
            delegable: false,
          },
          { id: "44444444-4444-4444-4444-444444444444" }
        ),
      ])
    );

    expect(bundle.definitions.map((definition) => `${definition.kind}:${definition.slug}`)).toEqual(
      ["AccessGrant:github-support", "Role:ops-reviewer"]
    );
  });

  it("pins declared Skill companion files into the signed runtime snapshot", () => {
    const bundle = compileExecutionBundle({
      ...request([
        def("Skill", "issue-triage", {
          instructions: { path: "SKILL.md" },
          scripts: ["scripts/classify.py"],
          trustTier: "first_party",
        }),
      ]),
      files: [
        { path: "skills/issue-triage/SKILL.md", content: "Classify issues." },
        {
          path: "skills/issue-triage/scripts/classify.py",
          content: "print('ok')\n",
        },
      ],
    });

    expect(bundle.assets.map((asset) => asset.path)).toEqual(["scripts/classify.py", "SKILL.md"]);
    expect(bundle.assets[0]?.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.isFrozen(bundle.assets)).toBe(true);
  });

  it("keeps the digest unchanged for a previously valid bundle", () => {
    const files = [
      { path: "skills/issue-triage/SKILL.md", content: "Classify issues." },
      {
        path: "skills/issue-triage/scripts/classify.py",
        content: "print('ok')\n",
      },
    ];
    const skill = () =>
      def("Skill", "issue-triage", {
        instructions: { path: "SKILL.md" },
        scripts: ["scripts/classify.py"],
        trustTier: "first_party",
      });
    const bundle = compileExecutionBundle({ ...request([skill()]), files });

    expect(computeBundleDigest(bundle)).toBe(
      "00e6e184fb2afb1bf52594f1e372b614bc9e91266f122e182e30f05d46e2fa59"
    );

    // The digest is a content address: republishing identical content under new lineage is stable.
    const reLineaged = compileExecutionBundle({
      businessId: "biz-1",
      changesetId: "cs-2",
      commitSha: "deadbeef",
      documents: [skill()],
      files,
    });
    expect(computeBundleDigest(reLineaged)).toBe(computeBundleDigest(bundle));
  });

  it("pins declared Agent instructions into the signed runtime snapshot", () => {
    const bundle = compileExecutionBundle({
      ...request([
        model("fast"),
        def("Agent", "triage", {
          owner: "ops",
          instructions: { path: "instructions.md" },
          modelProfile: "fast",
          autonomy: "answer_only",
          trustTier: "first_party",
        }),
      ]),
      files: [{ path: "agents/triage/instructions.md", content: "Help the operator.\n" }],
    });

    expect(bundle.assets.map((asset) => asset.path)).toEqual(["instructions.md"]);
    expect(bundle.assets[0]?.ownerDefinitionId).toBe("id-Agent-triage");
  });

  it("pins enabled Resource hooks into the signed runtime snapshot", () => {
    const bundle = compileExecutionBundle({
      ...request([
        def("Resource", "customer", {
          recordSchema: { type: "object", properties: {} },
          hooks: { enabled: true },
        }),
      ]),
      files: [{ path: "resources/customer/hooks.ts", content: "export const hooks = {};\n" }],
    });

    expect(bundle.assets.map((asset) => asset.path)).toEqual(["hooks.ts"]);
    expect(bundle.assets[0]?.ownerDefinitionId).toBe("id-Resource-customer");
  });

  it("uses the definition id for swept undeclared companions when the owner exists", () => {
    const bundle = compileExecutionBundle({
      ...request([
        def("Skill", "issue-triage", {
          instructions: { path: "SKILL.md" },
          scripts: ["scripts/main.ts"],
          trustTier: "first_party",
        }),
      ]),
      files: [
        { path: "skills/issue-triage/SKILL.md", content: "Triage issues.\n" },
        {
          path: "skills/issue-triage/scripts/main.ts",
          content: "import { classify } from './helper';\nclassify();\n",
        },
        {
          path: "skills/issue-triage/scripts/helper.ts",
          content: "export function classify() { return 'bug'; }\n",
        },
      ],
    });

    expect(
      bundle.assets
        .filter((asset) => asset.path.startsWith("scripts/"))
        .map((asset) => `${asset.ownerDefinitionId}:${asset.path}`)
    ).toEqual(["id-Skill-issue-triage:scripts/helper.ts", "id-Skill-issue-triage:scripts/main.ts"]);
  });

  it("pins delegated source files without requiring schema definitions", () => {
    const bundle = compileExecutionBundle({
      ...request([]),
      files: [
        {
          path: "guardrails.yaml",
          content: "input:\n  - guard: prompt_injection\n    sensitivity: medium\n",
        },
        {
          path: "surface-components/summary-card/component.yaml",
          content: "name: summary-card\ncomponent: card\n",
        },
        {
          path: "surface-components/summary-card/views/default.yaml",
          content: "body: Ready\n",
        },
      ],
    });

    expect(bundle.assets.map((asset) => `${asset.ownerDefinitionId}:${asset.path}`)).toEqual([
      "GuardrailsPolicy:guardrails.yaml",
      "SurfaceComponent:summary-card:component.yaml",
      "SurfaceComponent:summary-card:views/default.yaml",
    ]);
  });

  it("rejects a declared Skill companion file missing from the committed tree", () => {
    const error = failure(() =>
      compileExecutionBundle({
        ...request([
          def("Skill", "issue-triage", {
            instructions: { path: "SKILL.md" },
            scripts: ["scripts/missing.py"],
            trustTier: "first_party",
          }),
        ]),
        files: [{ path: "skills/issue-triage/SKILL.md", content: "Classify issues." }],
      })
    );
    expect(error.code).toBe("INVALID_DEFINITION");
    expect(error.subject).toBe("Skill:issue-triage");
  });

  it("rejects a declared Agent companion file missing from the committed tree", () => {
    const error = failure(() =>
      compileExecutionBundle({
        ...request([
          model("fast"),
          def("Agent", "triage", {
            owner: "ops",
            instructions: { path: "instructions.md" },
            modelProfile: "fast",
            autonomy: "answer_only",
            trustTier: "first_party",
          }),
        ]),
        files: [],
      })
    );
    expect(error.code).toBe("INVALID_DEFINITION");
    expect(error.subject).toBe("Agent:triage");
  });

  it("detaches and deeply freezes authored documents", () => {
    const document = model("fast");
    const bundle = compileExecutionBundle(request([document]));
    const compiled = bundle.definitions[0];
    if (!compiled) throw new Error("expected compiled definition");
    const originalDigest = computeBundleDigest(bundle);

    (document.spec as Record<string, unknown>).model = "mutated";

    expect((compiled.document.spec as Record<string, unknown>).model).toBe("m");
    expect(computeBundleDigest(bundle)).toBe(originalDigest);
    expect(Object.isFrozen(compiled.document.spec)).toBe(true);
  });

  it("rejects a reference that does not resolve in the compiled tree", () => {
    const error = failure(() =>
      compileExecutionBundle(request([def("Agent", "triage", { modelProfile: "missing" })]))
    );
    expect(error.code satisfies BundleErrorCode).toBe("UNRESOLVED_REF");
    expect(error.field).toBe("/spec/modelProfile");
    expect(error.subject).toBe("Agent:triage");
  });

  it("rejects a version constraint the compiled tree cannot satisfy", () => {
    const error = failure(() =>
      compileExecutionBundle(
        request([
          def("Routine", "child", { start: "s", states: [] }, { authoredVersion: 1 }),
          def("Routine", "parent", {
            start: "s",
            states: [
              { name: "s", type: "child_routine", routineRef: { name: "child", version: "9" } },
            ],
          }),
        ])
      )
    );
    expect(error.code).toBe("VERSION_UNSATISFIED");
    expect(error.field).toBe("/spec/states/0/routineRef/version");
  });

  it("rejects an ID-based reference whose version constraint does not match", () => {
    const routineId = "11111111-1111-1111-1111-111111111111";
    const error = failure(() =>
      compileExecutionBundle(
        request([
          def(
            "Routine",
            "child",
            { start: "s", states: [] },
            { id: routineId, authoredVersion: 2 }
          ),
          def("Routine", "parent", {
            start: "s",
            states: [
              {
                name: "s",
                type: "child_routine",
                routineRef: { id: routineId, name: "child", version: "1" },
              },
            ],
          }),
        ])
      )
    );

    expect(error.code).toBe("VERSION_UNSATISFIED");
    expect(error.field).toBe("/spec/states/0/routineRef/version");
  });

  it("rejects inline credential material instead of an opaque reference", () => {
    const error = failure(() =>
      compileExecutionBundle(
        request([
          def("Integration", "slack", {
            credentialRef: "-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----",
          }),
        ])
      )
    );
    expect(error.code).toBe("SECRET_MATERIAL");
    expect(error.subject).toBe("Integration:slack");
    expect(error.message).not.toContain("PRIVATE KEY");
  });

  it("rejects credential material patterns at any depth without echoing values", () => {
    for (const value of [
      "-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----",
      "sk-1234567890abcdef",
      "xoxb-1234567890-secret",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature",
    ]) {
      const error = failure(() =>
        compileExecutionBundle(
          request([
            def("Integration", "slack", {
              nested: { arbitrary: [{ harmless: "ok" }, { value }] },
            }),
          ])
        )
      );

      expect(error.code).toBe("SECRET_MATERIAL");
      expect(error.message).not.toContain(value);
    }
  });

  it("rejects a plaintext value under a secret-bearing field", () => {
    const error = failure(() =>
      compileExecutionBundle(
        request([def("Integration", "slack", { auth: { password: "correct horse battery" } })])
      )
    );
    expect(error.code).toBe("SECRET_MATERIAL");
    expect(error.field).toBe("/spec/auth/password");
    expect(error.message).not.toContain("correct horse");
  });

  it("rejects short plaintext secrets under secret-bearing fields", () => {
    for (const spec of [
      { password: "hunter2" },
      { apiKey: "sk-not-actually-a-placeholder" },
      { credentialRefs: ["secret://credentials/slack/support", "hunter2"] },
    ]) {
      const error = failure(() =>
        compileExecutionBundle(request([def("Integration", "slack", spec)]))
      );
      expect(error.code).toBe("SECRET_MATERIAL");
      expect(error.message).not.toContain("hunter2");
      expect(error.message).not.toContain("sk-not");
    }
  });

  it("accepts Tool input schemas with secret-named reference properties", () => {
    const bundle = compileExecutionBundle(
      request([
        def("ToolContract", "rotate-api-key", {
          toolId: "integration.rotate_api_key",
          toolVersion: "1",
          description: "Rotate a provider API key reference.",
          action: "integration.rotate_api_key",
          inputSchema: {
            type: "object",
            properties: {
              apiKey: {
                type: "string",
                description: "Opaque secret:// reference to the current provider API key.",
              },
            },
            required: ["apiKey"],
            additionalProperties: false,
          },
          outputSchema: { type: "object", properties: {}, additionalProperties: false },
          riskClass: "high",
          mutating: true,
          dryRun: false,
          idempotency: { strategy: "provider" },
          adapter: { kind: "integration", ref: "github" },
        }),
      ])
    );

    expect(bundle.definitions).toHaveLength(1);
  });

  it("accepts legitimate secret reference forms", () => {
    const bundle = compileExecutionBundle(
      request([
        def("Integration", "slack", {
          appCredentialRef: "secret://github",
          credentialRef: "secret://credentials/slack/support",
          credentialRefs: [
            "secret://integration.slack.SLACK_BOT_TOKEN",
            "secret://integrations/acme/egress/ACME_TOKEN",
            "secret://integrations/github/installation-token",
          ],
          verification: { secretRef: "secret://github/webhook" },
        }),
      ])
    );
    expect(bundle.definitions).toHaveLength(1);
  });

  it("rejects an oversized single asset with the path and limit", () => {
    const error = failure(() =>
      compileExecutionBundle({
        ...request([]),
        files: [
          {
            path: "skills/issue-triage/assets/model.bin",
            content: largeText(MAX_BUNDLE_ASSET_BYTES + 1),
          },
        ],
      })
    );

    expect(error.code).toBe("INVALID_DEFINITION");
    expect(error.message).toContain("skills/issue-triage/assets/model.bin");
    expect(error.message).toContain("2 MiB per-asset limit");
  });

  it("accepts mature Soul trees with many small assets when total bytes stay bounded", () => {
    const files = Array.from({ length: 300 }, (_, index) => ({
      path: `docs/asset-${index}.md`,
      content: "ok\n",
    }));
    const bundle = compileExecutionBundle({ ...request([]), files });

    expect(bundle.assets).toHaveLength(files.length);
  });

  it("rejects an oversized total asset payload with the offending path and limit", () => {
    const chunkBytes = MAX_BUNDLE_ASSET_BYTES;
    const files = Array.from(
      { length: Math.floor(MAX_BUNDLE_TOTAL_ASSET_BYTES / chunkBytes) + 1 },
      (_, index) => ({
        path: `docs/chunk-${index}.md`,
        content: largeText(chunkBytes),
      })
    );
    const error = failure(() => compileExecutionBundle({ ...request([]), files }));

    expect(error.code).toBe("INVALID_DEFINITION");
    expect(error.message).toContain(`docs/chunk-${files.length - 1}.md`);
    expect(error.message).toContain("16 MiB total asset limit");
  });

  it("rejects NUL-byte asset content before jsonb storage", () => {
    const error = failure(() =>
      compileExecutionBundle({
        ...request([]),
        files: [{ path: "skills/issue-triage/assets/binary.bin", content: "ok\u0000bad" }],
      })
    );

    expect(error.code).toBe("INVALID_DEFINITION");
    expect(error.message).toContain("skills/issue-triage/assets/binary.bin");
    expect(error.message).toContain("NUL bytes");
  });

  it("rejects a document that is missing stable authored identity", () => {
    const broken = {
      apiVersion: API,
      kind: "Agent",
      spec: {},
    } as unknown as VersionedSchemaDocument;
    expect(failure(() => compileExecutionBundle(request([broken]))).code).toBe(
      "INVALID_DEFINITION"
    );
  });
});
