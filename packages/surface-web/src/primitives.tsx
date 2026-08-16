/** Shared web-renderer props, value formatting, and the panel/alert/action chrome every block reuses. */

import type { ResolvedSurfaceViewNode, SurfaceAction, SurfaceArtifact } from "@tulipfarm/surface";
import type { ReactNode } from "react";

export interface SurfaceWebProps {
  readonly artifact: SurfaceArtifact;
  readonly onInteraction?: (
    handle: string,
    input: Readonly<Record<string, unknown>>
  ) => void | Promise<void>;
  readonly actionHandleFor?: (action: SurfaceAction) => string | undefined;
}

export interface SurfaceCompositionProps extends SurfaceWebProps {
  readonly view: ResolvedSurfaceViewNode;
}

export function string(value: unknown): string {
  if (value === null || value === undefined) return "—";
  return typeof value === "string" ? value : JSON.stringify(value);
}

export function humanize(value: string): string {
  const spaced = value
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim();
  return spaced.length === 0 ? value : `${spaced[0]?.toUpperCase() ?? ""}${spaced.slice(1)}`;
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
}

export function formatMeasure(value: number | string, unit?: string, currency?: string): string {
  const formatted = typeof value === "number" ? formatNumber(value) : value;
  if (currency) return `${currency} ${formatted}`;
  return unit ? `${formatted} ${unit}` : formatted;
}

export function ratio(value: number, max: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) return 0;
  return Math.min(1, Math.max(0, value / max));
}

export function SurfacePanel({
  kind,
  eyebrow,
  title,
  meta,
  children,
}: {
  readonly kind: string;
  readonly eyebrow: string;
  readonly title?: string;
  readonly meta?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <section data-surface-panel data-surface-kind={kind} aria-label={title ?? eyebrow}>
      <header data-surface-panel-header>
        <div data-surface-panel-heading>
          <span data-surface-eyebrow>{eyebrow}</span>
          {title ? <h3>{title}</h3> : null}
        </div>
        {meta ? <div data-surface-panel-meta>{meta}</div> : null}
      </header>
      <div data-surface-panel-body>{children}</div>
    </section>
  );
}

export function SurfaceAlert({
  severity,
  eyebrow,
  title,
  message,
}: {
  readonly severity: string;
  readonly eyebrow: string;
  readonly title?: string;
  readonly message: string;
}) {
  return (
    <div role="alert" data-surface-alert data-severity={severity}>
      <div data-surface-alert-marker aria-hidden="true" />
      <div data-surface-alert-content>
        <span data-surface-eyebrow>{eyebrow}</span>
        {title !== undefined ? <strong>{title}</strong> : null}
        <p>{message}</p>
      </div>
    </div>
  );
}

export function ActionButton(props: {
  readonly label: string;
  readonly action: SurfaceAction;
  readonly onInteraction?: SurfaceWebProps["onInteraction"];
  readonly actionHandleFor?: SurfaceWebProps["actionHandleFor"];
  readonly disabled?: boolean;
  readonly selected?: boolean;
  readonly primary?: boolean;
  readonly submit?: boolean;
}) {
  const handle = props.actionHandleFor?.(props.action);
  return (
    <button
      type={props.submit ? "submit" : "button"}
      disabled={props.disabled || props.action.disabled || !handle}
      aria-label={props.selected ? `${props.label}, selected` : undefined}
      aria-pressed={props.selected}
      data-surface-action={handle}
      data-surface-button
      data-variant={props.primary ? "primary" : "secondary"}
      onClick={
        props.submit
          ? undefined
          : () => {
              if (handle) void props.onInteraction?.(handle, props.action.payload ?? {});
            }
      }
    >
      <span>{props.label}</span>
      {props.selected ? <span data-surface-button-state>selected</span> : null}
    </button>
  );
}
