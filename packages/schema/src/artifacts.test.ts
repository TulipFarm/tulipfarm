import { describe, expect, it } from "vitest";
import {
  ARTIFACT_LAYOUTS,
  artifactDirectory,
  artifactLayout,
  classifySoulPath,
  companionPath,
  DELEGATED_ARTIFACT_KINDS,
  definitionPath,
  isDefinitionKind,
  isLiveKind,
  isPinnedKind,
  temporalClassOf,
  withinArtifactTree,
} from "./artifacts";
import { DEFINITION_KINDS } from "./definitions";

describe("artifact layout table", () => {
  it("declares a unique kind and directory per artifact", () => {
    const kinds = ARTIFACT_LAYOUTS.map((l) => l.kind);
    expect(new Set(kinds).size).toBe(kinds.length);
    const directories = ARTIFACT_LAYOUTS.filter((l) => l.scope === "collection").map(
      (l) => l.directory
    );
    expect(new Set(directories).size).toBe(directories.length);
  });

  it("never leaves a path with an empty set of content checks", () => {
    for (const layout of ARTIFACT_LAYOUTS) {
      expect(layout.definitionModes.length).toBeGreaterThan(0);
      for (const companion of layout.companions) {
        expect(companion.modes.length).toBeGreaterThan(0);
      }
    }
  });

  it("routes every non-delegated kind to the strict definition registry", () => {
    for (const layout of ARTIFACT_LAYOUTS) {
      if (!layout.definitionModes.includes("definition")) continue;
      expect(isDefinitionKind(layout.kind)).toBe(true);
    }
  });

  it("gives every collection kind a directory and every singleton none", () => {
    for (const layout of ARTIFACT_LAYOUTS) {
      expect(layout.directory === "").toBe(layout.scope === "singleton");
    }
  });

  it("declares a temporal class for every layout", () => {
    for (const layout of ARTIFACT_LAYOUTS) {
      expect(["pinned", "live"]).toContain(layout.temporalClass);
      expect(temporalClassOf(layout.kind)).toBe(layout.temporalClass);
    }
  });

  it("covers every artifact kind so a new kind must choose a temporal class", () => {
    const allKinds = [...DEFINITION_KINDS, ...DELEGATED_ARTIFACT_KINDS].sort();
    const layoutKinds = ARTIFACT_LAYOUTS.map((layout) => layout.kind).sort();

    expect(layoutKinds).toEqual(allKinds);
    for (const kind of allKinds) {
      expect(artifactLayout(kind)?.temporalClass).toEqual(expect.stringMatching(/^(pinned|live)$/));
    }
  });
});

describe("artifact temporal classes", () => {
  it("keeps authority live", () => {
    expect(temporalClassOf("Role")).toBe("live");
    expect(temporalClassOf("AccessGrant")).toBe("live");
    expect(isLiveKind("Role")).toBe(true);
    expect(isLiveKind("AccessGrant")).toBe(true);
  });

  it("keeps core behaviour pinned", () => {
    expect(temporalClassOf("Routine")).toBe("pinned");
    expect(temporalClassOf("ToolContract")).toBe("pinned");
    expect(temporalClassOf("Guardrail")).toBe("pinned");
    expect(isPinnedKind("Routine")).toBe(true);
    expect(isPinnedKind("ToolContract")).toBe(true);
    expect(isPinnedKind("Guardrail")).toBe(true);
  });

  it("fails closed for unknown kinds", () => {
    expect(temporalClassOf("UnknownKind")).toBeNull();
    expect(isPinnedKind("UnknownKind")).toBe(false);
    expect(isLiveKind("UnknownKind")).toBe(false);
  });
});

describe("classifySoulPath — the layout the runtime actually writes today", () => {
  const legacyPaths = [
    ["agents/support/AGENT.md", "Agent"],
    ["resources/employee/schema.yml", "Resource"],
    ["integrations/github/manifest.yml", "Integration"],
  ] as const;

  it.each(legacyPaths)("accepts %s as a legacy definition", (path, kind) => {
    const result = classifySoulPath(path);
    expect(result).not.toBeNull();
    expect(result?.kind).toBe(kind);
    expect(result?.definition).toBe(true);
    expect(result?.modes).toEqual(["legacy"]);
  });

  it("accepts the paths the loader reads", () => {
    for (const path of [
      "soul.yaml",
      "guardrails.yaml",
      "observability.config.yaml",
      "skills-lock.json",
      "skills/triage/SKILL.md",
      "routines/onboarding/routine.yaml",
      "routines/onboarding/hooks.ts",
      "resources/employee/hooks.ts",
      "surface-components/approval-card/component.yaml",
      "surface-components/approval-card/views/slack.yaml",
      "integrations/github/connection.yaml",
      "integrations/github/setup-guide.md",
    ]) {
      expect(classifySoulPath(path), path).not.toBeNull();
    }
  });

  it("accepts the canonical definition path for every collection kind", () => {
    for (const layout of ARTIFACT_LAYOUTS) {
      if (layout.scope !== "collection") continue;
      const path = definitionPath(layout.kind, "example");
      const result = classifySoulPath(path);
      expect(result?.kind, path).toBe(layout.kind);
      expect(result?.definition, path).toBe(true);
      expect(result?.slug, path).toBe("example");
    }
  });
});

describe("classifySoulPath — content modes", () => {
  it("treats SKILL.md as either a legacy definition or prose", () => {
    const result = classifySoulPath("skills/triage/SKILL.md");
    expect(result?.modes).toEqual(["legacy", "prose"]);
    expect(result?.definition).toBe(true);
  });

  it("keeps instructions.md prose-only so a companion cannot smuggle in config", () => {
    const result = classifySoulPath("agents/support/instructions.md");
    expect(result?.modes).toEqual(["prose"]);
    expect(result?.definition).toBe(false);
  });

  it("marks code as executable rather than validating it as configuration", () => {
    expect(classifySoulPath("resources/employee/hooks.ts")?.modes).toEqual(["executable"]);
    expect(classifySoulPath("skills/triage/scripts/run.py")?.modes).toEqual(["executable"]);
  });

  it("admits both formats where the migration reuses the same filename", () => {
    expect(classifySoulPath("routines/onboarding/routine.yaml")?.modes).toEqual([
      "definition",
      "legacy",
    ]);
    expect(classifySoulPath("soul.yaml")?.modes).toEqual(["definition", "legacy"]);
  });

  it("marks machine-written state as managed", () => {
    expect(classifySoulPath("skills-lock.json")?.modes).toEqual(["managed"]);
    expect(classifySoulPath("integrations/github/connection.yaml")?.modes).toEqual(["managed"]);
  });
});

describe("classifySoulPath — rejection", () => {
  it.each([
    ["", "empty"],
    ["/etc/passwd", "absolute"],
    ["../outside.yaml", "traversal"],
    ["agents/../../escape.yaml", "traversal mid-path"],
    ["agents\\support\\AGENT.md", "backslash"],
    ["agents//support/agent.yaml", "empty segment"],
    ["unknown-dir/thing/file.yaml", "unknown directory"],
    ["agents/support/random.txt", "undeclared companion"],
    ["agents/Support/agent.yaml", "non-kebab slug"],
    ["agents/support", "directory, not a file"],
    ["random-root-file.yaml", "unknown singleton"],
    ["agents/support/nested/deep/agent.yaml", "definition file not at the artifact root"],
  ])("rejects %s (%s)", (path) => {
    expect(classifySoulPath(path)).toBeNull();
  });

  it("rejects a path longer than the limit", () => {
    expect(classifySoulPath(`agents/support/${"a".repeat(1100)}.md`)).toBeNull();
  });

  it("does not let an extension glob match inside a subdirectory", () => {
    expect(classifySoulPath("integrations/github/nested/spec.json")).toBeNull();
  });
});

describe("path builders", () => {
  it("builds paths that classify back to the same artifact", () => {
    for (const layout of ARTIFACT_LAYOUTS) {
      const path =
        layout.scope === "singleton"
          ? definitionPath(layout.kind)
          : definitionPath(layout.kind, "example");
      expect(classifySoulPath(path)?.kind, path).toBe(layout.kind);
    }
  });

  it("builds companion paths", () => {
    expect(companionPath("Agent", "support", "instructions.md")).toBe(
      "agents/support/instructions.md"
    );
    expect(companionPath("Skill", "triage", "assets/logo.png")).toBe(
      "skills/triage/assets/logo.png"
    );
  });

  it("refuses to build a path the gate would reject", () => {
    expect(() => companionPath("Agent", "support", "secrets.env")).toThrow();
    expect(() => definitionPath("Agent", "Not A Slug")).toThrow();
    expect(() => artifactDirectory("Agent", "../escape")).toThrow();
    expect(() => definitionPath("Settings", "slug")).not.toThrow();
  });

  it("exposes layouts by kind", () => {
    expect(artifactLayout("Agent")?.directory).toBe("agents");
    expect(artifactLayout("Settings")?.scope).toBe("singleton");
  });
});

describe("withinArtifactTree", () => {
  // This predicate is what makes a delete reachable, so its boundary is a security boundary:
  // anything it admits, the write gateway will remove from the operator's repository.

  it("admits a stray file inside an artifact directory, which nothing else can remove", () => {
    expect(withinArtifactTree("agents/support/notes.md")).toBe(true);
    expect(withinArtifactTree("skills/triage/leftover.tmp")).toBe(true);
    expect(withinArtifactTree("integrations/slack/old-spec.yaml")).toBe(true);
  });

  it("admits every path the registry already classifies", () => {
    expect(withinArtifactTree("agents/support/agent.yaml")).toBe(true);
    expect(withinArtifactTree("soul.yaml")).toBe(true);
  });

  it("refuses git's own metadata", () => {
    expect(withinArtifactTree(".git/config")).toBe(false);
    expect(withinArtifactTree(".git/hooks/pre-commit")).toBe(false);
  });

  it("refuses a top-level directory the registry does not govern", () => {
    expect(withinArtifactTree("models/balanced.yaml")).toBe(false);
    expect(withinArtifactTree("scripts/deploy.sh")).toBe(false);
    expect(withinArtifactTree("unknown.yaml")).toBe(false);
  });

  it("refuses anything that escapes the tree", () => {
    expect(withinArtifactTree("../escape.yaml")).toBe(false);
    expect(withinArtifactTree("agents/../../escape")).toBe(false);
    expect(withinArtifactTree("/etc/passwd")).toBe(false);
    expect(withinArtifactTree("agents\\support\\agent.yaml")).toBe(false);
    expect(withinArtifactTree("agents/support/\0.yaml")).toBe(false);
    expect(withinArtifactTree("")).toBe(false);
  });
});
