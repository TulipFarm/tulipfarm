import type { VersionedSchemaDocument } from "@tulipfarm/schema";
import { describe, expect, it } from "vitest";
import { compileExecutionBundle } from "./compiler";
import { createHmacBundleSigner, signExecutionBundle, verifyExecutionBundle } from "./signatures";
import { resolveRuntimeSkillCommands } from "./skill-commands";

const API = "tulipfarm.ai/v1";

function definition(kind: string, slug: string, spec: Record<string, unknown>) {
  return {
    apiVersion: API,
    kind,
    metadata: {
      id: `id-${kind}-${slug}`,
      slug,
      schemaVersion: 1,
      authoredVersion: 1,
      lifecycle: "published",
      publishedDigest: "a".repeat(64),
    },
    spec,
  } as unknown as VersionedSchemaDocument;
}

describe("resolveRuntimeSkillCommands", () => {
  it("resolves an immutable entrypoint and sandbox ToolContract from a verified bundle", () => {
    const signer = createHmacBundleSigner("key", "secret");
    const record = signExecutionBundle(
      compileExecutionBundle({
        businessId: "business-1",
        changesetId: "changeset-1",
        commitSha: "a".repeat(40),
        documents: [
          definition("ToolContract", "classify", {
            toolId: "issue.classify",
            toolVersion: "1",
            action: "classify",
            inputSchema: { type: "object" },
            outputSchema: { type: "object" },
            riskClass: "low",
            mutating: false,
            dryRun: false,
            idempotency: { strategy: "none" },
            adapter: { kind: "sandbox", ref: "skill:issue-triage/classify_issue" },
          }),
          definition("Skill", "issue-triage", {
            instructions: { path: "SKILL.md" },
            scripts: ["scripts/classify.py"],
            commands: [
              {
                name: "classify_issue",
                toolRef: "classify",
                runtimeProfile: "shell-ts-python-v1",
                entrypoint: "scripts/classify.py",
              },
            ],
            trustTier: "first_party",
          }),
        ],
        files: [
          { path: "skills/issue-triage/SKILL.md", content: "Classify the issue." },
          {
            path: "skills/issue-triage/scripts/classify.py",
            content: "print('ok')\n",
          },
        ],
      }),
      signer
    );
    const bundle = verifyExecutionBundle(record, signer);

    const commands = resolveRuntimeSkillCommands(bundle);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      skillSlug: "issue-triage",
      command: { name: "classify_issue" },
      tool: { spec: { toolId: "issue.classify" } },
      entrypoint: { path: "scripts/classify.py", content: "print('ok')\n" },
    });
  });
});
