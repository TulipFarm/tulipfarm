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
  readonly fields?: readonly { readonly type: "mrkdwn"; readonly text: string }[];
  readonly block_id?: string;
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
          elements: [
            {
              type: "static_select",
              action_id: actionHandle(action, context),
              options: (props.choices as Array<{ label: string; value: string }>).map((choice) => ({
                text: { type: "plain_text", text: choice.label },
                value: choice.value,
              })),
            },
          ],
        },
      ];
    }
    default:
      return [{ type: "section", text: { type: "mrkdwn", text: "Presentation unavailable." } }];
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
              element: {
                type: "plain_text_input",
                action_id: String(field.name),
              },
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
