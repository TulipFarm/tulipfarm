import type { SurfaceArtifact, SurfaceRenderIssue } from "./contracts";

const FORBIDDEN_KEYS = new Set(["css", "html", "javascript", "script", "srcdoc", "template"]);

export function lintSurfaceArtifact(artifact: SurfaceArtifact): readonly SurfaceRenderIssue[] {
  const issues: SurfaceRenderIssue[] = [];
  const visit = (value: unknown, path: string, depth: number): void => {
    if (depth > 12) {
      issues.push({
        code: "provider_limit",
        path,
        message: "Presentation data exceeds the maximum nesting depth.",
      });
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((entry, index) => {
        visit(entry, `${path}/${index}`, depth + 1);
      });
      return;
    }
    if (typeof value !== "object" || value === null) return;
    for (const [key, entry] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(key.toLowerCase())) {
        issues.push({
          code: "artifact_invalid",
          path: `${path}/${key}`,
          message: `Executable or presentation-specific field "${key}" is not allowed.`,
        });
      }
      visit(entry, `${path}/${key}`, depth + 1);
    }
  };
  visit(artifact.props, "/props", 0);
  if (JSON.stringify(artifact).length > 256_000) {
    issues.push({
      code: "provider_limit",
      path: "/",
      message: "Artifact exceeds the 256 KiB protocol limit.",
    });
  }
  return issues;
}
