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

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
}

function formatMeasure(value: number | string, unit?: unknown, currency?: unknown): string {
  const formatted = typeof value === "number" ? formatNumber(value) : value;
  if (typeof currency === "string") return `${currency} ${formatted}`;
  return typeof unit === "string" ? `${formatted} ${unit}` : formatted;
}

function ratio(value: number, max: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) return 0;
  return Math.min(1, Math.max(0, value / max));
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
    case "Metric":
      return (
        props.cells as Array<{
          label: string;
          value: number | string;
          unit?: string;
          delta?: { value: number | string; direction: string; label?: string };
          caption?: string;
        }>
      )
        .map((cell) =>
          [
            `### ${cell.label}`,
            `\`${formatMeasure(cell.value, cell.unit)}\``,
            cell.delta
              ? `_${cell.delta.direction}: ${formatMeasure(cell.delta.value)}${cell.delta.label ? ` ${cell.delta.label}` : ""}_`
              : undefined,
            cell.caption,
          ]
            .filter((line): line is string => typeof line === "string" && line.length > 0)
            .join("\n")
        )
        .join("\n\n");
    case "Timeline":
      return (
        props.entries as Array<{
          label: string;
          timestamp?: string;
          description?: string;
          status?: string;
        }>
      )
        .map((entry) =>
          [
            `- **${entry.label}**${entry.timestamp ? ` — ${entry.timestamp}` : ""}`,
            entry.description ? `  ${entry.description}` : undefined,
            entry.status ? `  _${entry.status}_` : undefined,
          ]
            .filter((line): line is string => typeof line === "string")
            .join("\n")
        )
        .join("\n");
    case "Comparison": {
      const options = props.options as Array<{ id: string; label: string; recommended?: boolean }>;
      const criteria = props.criteria as Array<{ id: string; label: string }>;
      const cells = props.cells as Array<{
        option: string;
        criterion: string;
        value: number | string | boolean;
      }>;
      const cellMap = new Map(cells.map((cell) => [`${cell.criterion}:${cell.option}`, cell]));
      return [
        `| Criteria | ${options.map((option) => `${option.label}${option.recommended ? " (recommended)" : ""}`).join(" | ")} |`,
        `| --- | ${options.map(() => "---").join(" | ")} |`,
        ...criteria.map(
          (criterion) =>
            `| ${criterion.label} | ${options.map((option) => String(cellMap.get(`${criterion.id}:${option.id}`)?.value ?? "")).join(" | ")} |`
        ),
      ].join("\n");
    }
    case "Breakdown": {
      const segments = props.segments as Array<{ label: string; value: number }>;
      const sum = segments.reduce((total, segment) => total + segment.value, 0);
      const total = typeof props.total === "number" ? props.total : sum;
      return segments
        .map(
          (segment) =>
            `- **${segment.label}:** ${formatMeasure(segment.value, props.unit, props.currency)} (${formatNumber(ratio(segment.value, total) * 100)}%)`
        )
        .join("\n");
    }
    case "Gauge": {
      const value = typeof props.value === "number" ? props.value : 0;
      const max = typeof props.max === "number" ? props.max : 1;
      const target = typeof props.target === "number" ? props.target : undefined;
      return [
        `**${String(props.label ?? "Progress")}**`,
        `${formatMeasure(value, props.unit)} / ${formatMeasure(max, props.unit)} (${formatNumber(ratio(value, max) * 100)}%)`,
        target !== undefined ? `Target: ${formatMeasure(target, props.unit)}` : undefined,
      ]
        .filter((line): line is string => typeof line === "string")
        .join("\n");
    }
    default:
      return "Presentation unavailable.";
  }
}

function createGitHubRenderer(
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
