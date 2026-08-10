import {
  type SurfaceAction,
  type SurfaceArtifact,
  type SurfaceRenderContext,
  type SurfaceRenderer,
  sameTarget,
  validateSurfaceArtifact,
} from "@tulipfarm/surface";
import { slackMessageManifest, slackModalManifest } from "./manifest";

export interface SlackBlock {
  readonly type: string;
  readonly text?: { readonly type: "mrkdwn" | "plain_text"; readonly text: string };
  readonly elements?: readonly Record<string, unknown>[];
  readonly accessory?: Record<string, unknown>;
  readonly fields?: readonly { readonly type: "mrkdwn"; readonly text: string }[];
  readonly block_id?: string;
  readonly image_url?: string;
  readonly alt_text?: string;
  readonly title?: { readonly type: "plain_text"; readonly text: string };
}

export interface SlackSurfacePayload {
  readonly response_type: "message" | "modal";
  readonly text?: string;
  readonly blocks: readonly SlackBlock[];
  readonly view?: Readonly<Record<string, unknown>>;
}

function actionHandle(action: SurfaceAction, context: SurfaceRenderContext): string {
  const handle = context.actionHandleFor?.(action);
  if (!handle) throw new Error(`Missing opaque action handle for ${action.event}.`);
  return handle;
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

function blocksFor(
  artifact: SurfaceArtifact,
  context: SurfaceRenderContext
): readonly SlackBlock[] {
  const props = artifact.props as Record<string, unknown>;
  switch (artifact.component.name) {
    case "Heading":
      return [{ type: "header", text: { type: "plain_text", text: String(props.text) } }];
    case "Text":
      return [{ type: "section", text: { type: "mrkdwn", text: String(props.text) } }];
    case "Section":
    case "Card":
      return [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `${(props.heading ?? props.title) ? `*${String(props.heading ?? props.title)}*\n` : ""}${String(props.body)}`,
          },
        },
      ];
    case "Status":
      return [
        { type: "context", elements: [{ type: "mrkdwn", text: `*${String(props.label)}*` }] },
      ];
    case "Alert":
      return [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `${props.title ? `*${String(props.title)}*\n` : ""}${String(props.message)}`,
          },
        },
      ];
    case "List":
      return [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: (props.items as string[])
              .map((item, index) => `${props.ordered ? `${index + 1}.` : "•"} ${item}`)
              .join("\n"),
          },
        },
      ];
    case "RecordDetail":
      return [
        {
          type: "section",
          fields: Object.entries(props.record as Record<string, unknown>).map(([key, value]) => ({
            type: "mrkdwn",
            text: `*${key}*\n${String(value)}`,
          })),
        },
      ];
    case "RecordTable": {
      const columns = props.columns as string[];
      const records = props.records as Array<Record<string, unknown>>;
      return [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: records
              .map((record) =>
                columns.map((column) => `*${column}:* ${String(record[column])}`).join(" · ")
              )
              .join("\n"),
          },
        },
      ];
    }
    case "Actions":
      return [
        {
          type: "actions",
          block_id: artifact.id,
          elements: (props.actions as Array<{ label: string; action: SurfaceAction }>).map(
            ({ label, action }) => ({
              type: "button",
              text: { type: "plain_text", text: label },
              action_id: actionHandle(action, context),
              value: actionHandle(action, context),
            })
          ),
        },
      ];
    case "Choices": {
      const action = props.action as SurfaceAction;
      return [
        {
          type: "section",
          text: { type: "mrkdwn", text: String(props.question) },
          accessory: {
            type: "static_select",
            action_id: actionHandle(action, context),
            options: (props.choices as Array<{ label: string; value: string }>).map((choice) => ({
              text: { type: "plain_text", text: choice.label },
              value: choice.value,
            })),
          },
        },
      ];
    }
    case "Divider":
      return [{ type: "divider" }];
    case "Image":
      return [
        {
          type: "image",
          image_url: String(props.url),
          alt_text: String(props.altText),
          ...(props.title ? { title: { type: "plain_text", text: String(props.title) } } : {}),
        },
      ];
    case "MultiChoice": {
      const action = props.action as SurfaceAction;
      return [
        {
          type: "section",
          text: { type: "mrkdwn", text: String(props.question) },
          accessory: {
            type: "multi_static_select",
            action_id: actionHandle(action, context),
            options: (props.choices as Array<{ label: string; value: string }>).map((choice) => ({
              text: { type: "plain_text", text: choice.label },
              value: choice.value,
            })),
          },
        },
      ];
    }
    case "Metric":
      return [
        {
          type: "section",
          fields: (
            props.cells as Array<{
              label: string;
              value: number | string;
              unit?: string;
              delta?: { value: number | string; direction: string; label?: string };
              caption?: string;
            }>
          ).map((cell) => ({
            type: "mrkdwn",
            text: [
              `*${cell.label}*`,
              `\`${formatMeasure(cell.value, cell.unit)}\``,
              cell.delta
                ? `${cell.delta.direction}: ${formatMeasure(cell.delta.value)}${cell.delta.label ? ` ${cell.delta.label}` : ""}`
                : undefined,
              cell.caption,
            ]
              .filter((line): line is string => typeof line === "string" && line.length > 0)
              .join("\n"),
          })),
        },
      ];
    case "Timeline":
      return [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: (
              props.entries as Array<{
                label: string;
                timestamp?: string;
                description?: string;
                status?: string;
              }>
            )
              .map((entry) =>
                [
                  `*${entry.label}*${entry.timestamp ? ` — ${entry.timestamp}` : ""}`,
                  entry.description,
                  entry.status ? `_${entry.status}_` : undefined,
                ]
                  .filter((line): line is string => typeof line === "string" && line.length > 0)
                  .join("\n")
              )
              .join("\n\n"),
          },
        },
      ];
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
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: criteria
              .map((criterion) =>
                [
                  `*${criterion.label}*`,
                  ...options.map((option) => {
                    const marker = option.recommended ? " (recommended)" : "";
                    return `• ${option.label}${marker}: ${String(cellMap.get(`${criterion.id}:${option.id}`)?.value ?? "—")}`;
                  }),
                ].join("\n")
              )
              .join("\n\n"),
          },
        },
      ];
    }
    case "Breakdown": {
      const segments = props.segments as Array<{ label: string; value: number }>;
      const sum = segments.reduce((total, segment) => total + segment.value, 0);
      const total = typeof props.total === "number" ? props.total : sum;
      return [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: segments
              .map(
                (segment) =>
                  `• *${segment.label}:* ${formatMeasure(segment.value, props.unit, props.currency)} (${formatNumber(ratio(segment.value, total) * 100)}%)`
              )
              .join("\n"),
          },
        },
      ];
    }
    case "Gauge": {
      const value = typeof props.value === "number" ? props.value : 0;
      const max = typeof props.max === "number" ? props.max : 1;
      const target = typeof props.target === "number" ? props.target : undefined;
      return [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: [
              props.label ? `*${String(props.label)}*` : "*Progress*",
              `${formatMeasure(value, props.unit)} / ${formatMeasure(max, props.unit)} (${formatNumber(ratio(value, max) * 100)}%)`,
              target !== undefined ? `Target: ${formatMeasure(target, props.unit)}` : undefined,
            ]
              .filter((line): line is string => typeof line === "string")
              .join("\n"),
          },
        },
      ];
    }
    default:
      return [{ type: "section", text: { type: "mrkdwn", text: "Presentation unavailable." } }];
  }
}

function formFieldElement(field: Record<string, unknown>): Record<string, unknown> {
  const actionId = String(field.name);
  const options = ((field.options as string[] | undefined) ?? []).map((option) => ({
    text: { type: "plain_text", text: option },
    value: option,
  }));
  switch (field.input) {
    case "email":
      return { type: "email_text_input", action_id: actionId };
    case "number":
      return { type: "number_input", action_id: actionId, is_decimal_allowed: true };
    case "textarea":
      return { type: "plain_text_input", action_id: actionId, multiline: true };
    case "select":
      return { type: "static_select", action_id: actionId, options };
    case "multiselect":
      return { type: "multi_static_select", action_id: actionId, options };
    case "checkbox":
      return { type: "checkboxes", action_id: actionId, options };
    case "radio":
      return { type: "radio_buttons", action_id: actionId, options };
    case "date":
      return { type: "datepicker", action_id: actionId };
    default:
      return { type: "plain_text_input", action_id: actionId };
  }
}

export function createSlackRenderer(
  surface: "message" | "modal"
): SurfaceRenderer<SlackSurfacePayload> {
  const target = { channel: "slack", surface } as const;
  const manifest = surface === "modal" ? slackModalManifest : slackMessageManifest;
  const renderer: SurfaceRenderer<SlackSurfacePayload> = {
    target,
    manifest,
    preflight: (artifact) => {
      const issues = [...validateSurfaceArtifact(artifact, [], manifest)];
      if (!sameTarget(artifact.target, target)) {
        issues.push({
          code: "component_unsupported",
          path: "/target",
          message: "Artifact target does not match this Slack renderer.",
        });
      }
      if (artifact.component.name === "RecordTable") {
        const count = (artifact.props.records as unknown[])?.length ?? 0;
        if (count > 25) {
          issues.push({
            code: "provider_limit",
            path: "/props/records",
            message: "Slack Record tables support at most 25 Records.",
          });
        }
      }
      return issues;
    },
    render: (artifact, context) => {
      const issues = renderer.preflight(artifact);
      if (issues.length > 0) throw new Error(issues.map((issue) => issue.message).join("; "));
      const blocks = blocksFor(artifact, context);
      if (surface === "modal" && artifact.component.name === "Form") {
        return {
          response_type: "modal",
          blocks: [],
          view: {
            type: "modal",
            callback_id: actionHandle(artifact.props.action as SurfaceAction, context),
            title: { type: "plain_text", text: String(artifact.props.title ?? "Input") },
            submit: { type: "plain_text", text: String(artifact.props.submit) },
            blocks: (artifact.props.fields as Array<Record<string, unknown>>).map((field) => ({
              type: "input",
              block_id: String(field.name),
              label: { type: "plain_text", text: String(field.label) },
              element: formFieldElement(field),
              optional: field.required !== true,
            })),
          },
        };
      }
      return { response_type: surface, blocks };
    },
    update: (_previous, artifact, context) => renderer.render(artifact, context),
  };
  return renderer;
}

export const slackMessageRenderer = createSlackRenderer("message");
export const slackModalRenderer = createSlackRenderer("modal");
