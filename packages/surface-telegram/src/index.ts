import {
  type SurfaceAction,
  type SurfaceArtifact,
  type SurfaceRenderContext,
  type SurfaceRenderer,
  sameTarget,
  validateSurfaceArtifact,
} from "@tulipfarm/surface";
import { telegramManifest } from "./manifest";

export interface TelegramSurfacePayload {
  readonly method: "sendMessage" | "editMessageText";
  readonly text: string;
  readonly parse_mode: "HTML";
  readonly reply_markup?: {
    readonly inline_keyboard: readonly (readonly {
      readonly text: string;
      readonly callback_data: string;
    }[])[];
  };
}

function actionHandle(action: SurfaceAction, context: SurfaceRenderContext): string {
  const handle = context.actionHandleFor?.(action);
  if (!handle) throw new Error(`Missing opaque action handle for ${action.event}.`);
  return handle;
}

function escapeTelegramHtml(value: unknown): string {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function renderText(artifact: SurfaceArtifact): string {
  const props = artifact.props as Record<string, unknown>;
  switch (artifact.component.name) {
    case "Heading":
      return `<b>${escapeTelegramHtml(props.text)}</b>`;
    case "Text":
      return escapeTelegramHtml(props.text);
    case "Section":
    case "Card":
      return `${(props.heading ?? props.title) ? `<b>${escapeTelegramHtml(props.heading ?? props.title)}</b>\n` : ""}${escapeTelegramHtml(props.body)}`;
    case "Status":
      return `<b>${escapeTelegramHtml(props.label)}</b>`;
    case "Alert":
      return `${props.title ? `<b>${escapeTelegramHtml(props.title)}</b>\n` : ""}${escapeTelegramHtml(props.message)}`;
    case "List":
      return (props.items as string[])
        .map(
          (item, index) => `${props.ordered ? `${index + 1}.` : "•"} ${escapeTelegramHtml(item)}`
        )
        .join("\n");
    case "RecordDetail":
      return Object.entries(props.record as Record<string, unknown>)
        .map(([key, value]) => `<b>${escapeTelegramHtml(key)}:</b> ${escapeTelegramHtml(value)}`)
        .join("\n");
    case "RecordTable": {
      const columns = props.columns as string[];
      return (props.records as Array<Record<string, unknown>>)
        .map((record) =>
          columns
            .map(
              (column) =>
                `<b>${escapeTelegramHtml(column)}:</b> ${escapeTelegramHtml(record[column])}`
            )
            .join(" · ")
        )
        .join("\n");
    }
    case "Choices":
      return escapeTelegramHtml(props.question);
    default:
      return "Presentation";
  }
}

function keyboard(
  artifact: SurfaceArtifact,
  context: SurfaceRenderContext
): TelegramSurfacePayload["reply_markup"] {
  const props = artifact.props as Record<string, unknown>;
  if (artifact.component.name === "Actions") {
    return {
      inline_keyboard: (props.actions as Array<{ label: string; action: SurfaceAction }>).map(
        ({ label, action }) => [
          {
            text: label,
            callback_data: actionHandle(action, context),
          },
        ]
      ),
    };
  }
  if (artifact.component.name === "Choices") {
    const action = props.action as SurfaceAction;
    return {
      inline_keyboard: (props.choices as Array<{ label: string; value: string }>).map((choice) => [
        {
          text: choice.label,
          callback_data: actionHandle(
            {
              ...action,
              payload: { ...action.payload, value: choice.value },
            },
            context
          ),
        },
      ]),
    };
  }
  return undefined;
}

const target = { channel: "telegram", surface: "message" } as const;

export const telegramRenderer: SurfaceRenderer<TelegramSurfacePayload> = {
  target,
  manifest: telegramManifest,
  preflight: (artifact) => {
    const issues = [...validateSurfaceArtifact(artifact, [], telegramManifest)];
    if (!sameTarget(artifact.target, target)) {
      issues.push({
        code: "component_unsupported",
        path: "/target",
        message: "Artifact target does not match the Telegram renderer.",
      });
    }
    if (renderText(artifact).length > 4_096) {
      issues.push({
        code: "provider_limit",
        path: "/props",
        message: "Telegram message text exceeds 4096 characters.",
      });
    }
    return issues;
  },
  render: (artifact, context) => {
    const issues = telegramRenderer.preflight(artifact);
    if (issues.length > 0) throw new Error(issues.map((issue) => issue.message).join("; "));
    return {
      method: "sendMessage",
      text: renderText(artifact),
      parse_mode: "HTML",
      reply_markup: keyboard(artifact, context),
    };
  },
  update: (_previous, artifact, context) => ({
    ...telegramRenderer.render(artifact, context),
    method: "editMessageText",
  }),
};
