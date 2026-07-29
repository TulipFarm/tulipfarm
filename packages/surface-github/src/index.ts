import {
  type SurfaceAction,
  type SurfaceArtifact,
  type SurfaceRenderContext,
  type SurfaceRenderer,
  sameTarget,
  validateSurfaceArtifact,
} from "@tulipfarm/surface";
import { githubCheckRunManifest, githubCommentManifest } from "./manifest";

export interface GitHubCommentPayload {
  readonly kind: "comment";
  readonly body: string;
}

export interface GitHubCheckRunPayload {
  readonly kind: "check-run";
  readonly name: string;
  readonly status: "completed";
  readonly conclusion: "success" | "neutral" | "failure";
  readonly output: { readonly title: string; readonly summary: string };
  readonly actions?: readonly {
    readonly label: string;
    readonly description: string;
    readonly identifier: string;
  }[];
}

export type GitHubSurfacePayload = GitHubCommentPayload | GitHubCheckRunPayload;

function githubActionHandle(action: SurfaceAction, context?: SurfaceRenderContext): string {
  return context?.actionHandleFor?.(action) ?? "action";
}

function markdown(artifact: SurfaceArtifact, context?: SurfaceRenderContext): string {
  const props = artifact.props as Record<string, unknown>;
  switch (artifact.component.name) {
    case "Heading":
      return `${"#".repeat(Number(props.level ?? 2))} ${String(props.text)}`;
    case "Text":
      return String(props.text);
    case "Section":
    case "Card":
      return `${(props.heading ?? props.title) ? `### ${String(props.heading ?? props.title)}\n\n` : ""}${String(props.body)}`;
    case "Status":
      return `**Status:** ${String(props.label)}`;
    case "Alert":
      return `> ${props.title ? `**${String(props.title)}** — ` : ""}${String(props.message)}`;
    case "List":
      return (props.items as string[])
        .map((item, index) => `${props.ordered ? `${index + 1}.` : "-"} ${item}`)
        .join("\n");
    case "RecordDetail":
      return Object.entries(props.record as Record<string, unknown>)
        .map(([key, value]) => `- **${key}:** ${String(value)}`)
        .join("\n");
    case "RecordTable": {
      const columns = props.columns as string[];
      const rows = props.records as Array<Record<string, unknown>>;
      return [
        `| ${columns.join(" | ")} |`,
        `| ${columns.map(() => "---").join(" | ")} |`,
        ...rows.map(
          (row) => `| ${columns.map((column) => String(row[column] ?? "")).join(" | ")} |`
        ),
      ].join("\n");
    }
    case "Actions":
      return (props.actions as Array<{ label: string; action: SurfaceAction }>)
        .map(
          ({ label, action }) => `- **${label}:** \`/tulip ${githubActionHandle(action, context)}\``
        )
        .join("\n");
    case "Choices": {
      const action = props.action as SurfaceAction;
      return [
        String(props.question),
        ...(props.choices as Array<{ label: string; value: string }>).map(
          (choice) =>
            `- **${choice.label}:** \`/tulip ${githubActionHandle(
              { ...action, payload: { ...action.payload, value: choice.value } },
              context
            )}\``
        ),
      ].join("\n");
    }
    default:
      return "Presentation unavailable.";
  }
}

export function createGitHubRenderer(
  surface: "comment" | "check-run"
): SurfaceRenderer<GitHubSurfacePayload> {
  const target = { channel: "github", surface } as const;
  const manifest = surface === "check-run" ? githubCheckRunManifest : githubCommentManifest;
  const renderer: SurfaceRenderer<GitHubSurfacePayload> = {
    target,
    manifest,
    preflight: (artifact) => {
      const issues = [...validateSurfaceArtifact(artifact, [], manifest)];
      if (!sameTarget(artifact.target, target)) {
        issues.push({
          code: "component_unsupported",
          path: "/target",
          message: "Artifact target does not match this GitHub renderer.",
        });
      }
      if (markdown(artifact).length > 65_535) {
        issues.push({
          code: "provider_limit",
          path: "/props",
          message: "GitHub Markdown exceeds the provider limit.",
        });
      }
      if (
        surface === "check-run" &&
        artifact.component.name === "Actions" &&
        (artifact.props.actions as unknown[]).length > 3
      ) {
        issues.push({
          code: "provider_limit",
          path: "/props/actions",
          message: "GitHub Check Runs support at most three requested actions.",
        });
      }
      return issues;
    },
    render: (artifact, context) => {
      const issues = renderer.preflight(artifact);
      if (issues.length > 0) throw new Error(issues.map((issue) => issue.message).join("; "));
      const body = markdown(artifact, context);
      if (surface === "comment") return { kind: "comment", body };
      const severity = String(artifact.props.severity ?? artifact.props.tone ?? "neutral");
      return {
        kind: "check-run",
        name: String(artifact.props.title ?? artifact.component.name),
        status: "completed",
        conclusion:
          severity === "error" || severity === "negative"
            ? "failure"
            : severity === "success" || severity === "positive"
              ? "success"
              : "neutral",
        output: {
          title: String(artifact.props.title ?? artifact.component.name),
          summary: body,
        },
        actions:
          artifact.component.name === "Actions"
            ? (
                artifact.props.actions as Array<{
                  label: string;
                  action: SurfaceAction;
                }>
              )
                .slice(0, 3)
                .map(({ label, action }) => ({
                  label,
                  description: label,
                  identifier: context.actionHandleFor?.(action) ?? "",
                }))
                .filter((action) => action.identifier.length > 0)
            : undefined,
      };
    },
    update: (_previous, artifact, context) => renderer.render(artifact, context),
  };
  return renderer;
}

export const githubCommentRenderer = createGitHubRenderer("comment");
export const githubCheckRunRenderer = createGitHubRenderer("check-run");
