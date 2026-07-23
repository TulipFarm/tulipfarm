import type { VersionedSchemaDocument } from "@tulipfarm/schema";
import { describe, expect, it } from "vitest";
import { BundleError, type BundleErrorCode } from "./bundle";
import { compileExecutionBundle } from "./compiler";

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
    expect(bundle.bundleVersion).toBe(1);
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
          def("Trigger", "t", { routineRef: { name: "child", version: "9" } }),
        ])
      )
    );
    expect(error.code).toBe("VERSION_UNSATISFIED");
    expect(error.field).toBe("/spec/routineRef/version");
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

  it("keeps opaque secret references", () => {
    const bundle = compileExecutionBundle(
      request([
        def("Integration", "slack", {
          credentialRef: "secret://credentials/slack/support",
          verification: { secretRef: "webhook.slack.signing" },
        }),
      ])
    );
    expect(bundle.definitions).toHaveLength(1);
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
