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
            `<b>${escapeTelegramHtml(cell.label)}</b>: <code>${escapeTelegramHtml(formatMeasure(cell.value, cell.unit))}</code>`,
            cell.delta
              ? `${escapeTelegramHtml(cell.delta.direction)} ${escapeTelegramHtml(formatMeasure(cell.delta.value))}${cell.delta.label ? ` ${escapeTelegramHtml(cell.delta.label)}` : ""}`
              : undefined,
            cell.caption ? escapeTelegramHtml(cell.caption) : undefined,
          ]
            .filter((line): line is string => typeof line === "string")
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
            `<b>${escapeTelegramHtml(entry.label)}</b>${entry.timestamp ? ` — ${escapeTelegramHtml(entry.timestamp)}` : ""}`,
            entry.description ? escapeTelegramHtml(entry.description) : undefined,
            entry.status ? `<i>${escapeTelegramHtml(entry.status)}</i>` : undefined,
          ]
            .filter((line): line is string => typeof line === "string")
            .join("\n")
        )
        .join("\n\n");
    case "Comparison": {
      const options = props.options as Array<{ id: string; label: string; recommended?: boolean }>;
      const criteria = props.criteria as Array<{ id: string; label: string }>;
      const cells = props.cells as Array<{
        option: string;
        criterion: string;
        value: number | string | boolean;
      }>;
      const cellMap = new Map(cells.map((cell) => [`${cell.criterion}:${cell.option}`, cell]));
      return criteria
        .map((criterion) =>
          [
            `<b>${escapeTelegramHtml(criterion.label)}</b>`,
            ...options.map((option) => {
              const marker = option.recommended ? " (recommended)" : "";
              return `• ${escapeTelegramHtml(option.label)}${marker}: ${escapeTelegramHtml(cellMap.get(`${criterion.id}:${option.id}`)?.value ?? "—")}`;
            }),
          ].join("\n")
        )
        .join("\n\n");
    }
    case "Breakdown": {
      const segments = props.segments as Array<{ label: string; value: number }>;
      const sum = segments.reduce((total, segment) => total + segment.value, 0);
      const total = typeof props.total === "number" ? props.total : sum;
      return segments
        .map(
          (segment) =>
            `• <b>${escapeTelegramHtml(segment.label)}:</b> ${escapeTelegramHtml(formatMeasure(segment.value, props.unit, props.currency))} (${formatNumber(ratio(segment.value, total) * 100)}%)`
        )
        .join("\n");
    }
    case "Gauge": {
      const value = typeof props.value === "number" ? props.value : 0;
      const max = typeof props.max === "number" ? props.max : 1;
      const target = typeof props.target === "number" ? props.target : undefined;
      return [
        props.label ? `<b>${escapeTelegramHtml(props.label)}</b>` : "<b>Progress</b>",
        `${escapeTelegramHtml(formatMeasure(value, props.unit))} / ${escapeTelegramHtml(formatMeasure(max, props.unit))} (${formatNumber(ratio(value, max) * 100)}%)`,
        target !== undefined
          ? `Target: ${escapeTelegramHtml(formatMeasure(target, props.unit))}`
          : undefined,
      ]
        .filter((line): line is string => typeof line === "string")
        .join("\n");
    }
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
