import {
  type ResolvedSurfaceViewNode,
  type SurfaceAction,
  type SurfaceArtifact,
  type SurfaceRenderer,
  sameTarget,
  targetKey,
  validateSurfaceArtifact,
} from "@tulipfarm/surface";
import type { ChangeEvent, CSSProperties, FormEvent, ReactElement, ReactNode } from "react";
import { useId, useState } from "react";
import { surfaceWebManifest } from "./manifest";

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

interface ChartSeries {
  readonly label: string;
  readonly values: readonly number[];
}

interface MetricCell {
  readonly label: string;
  readonly value: number | string;
  readonly unit?: string;
  readonly delta?: {
    readonly value: number | string;
    readonly direction: "up" | "down" | "flat";
    readonly label?: string;
  };
  readonly caption?: string;
}

interface TimelineEntry {
  readonly label: string;
  readonly timestamp?: string;
  readonly description?: string;
  readonly status?: string;
}

interface ComparisonOption {
  readonly id: string;
  readonly label: string;
  readonly recommended?: boolean;
}

interface ComparisonCriterion {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
}

interface ComparisonCell {
  readonly option: string;
  readonly criterion: string;
  readonly value: number | string | boolean;
  readonly note?: string;
}

interface BreakdownSegment {
  readonly label: string;
  readonly value: number;
}

interface GraphNode {
  readonly id: string;
  readonly label?: string;
}

interface GraphEdge {
  readonly source: string;
  readonly target: string;
}

function string(value: unknown): string {
  if (value === null || value === undefined) return "—";
  return typeof value === "string" ? value : JSON.stringify(value);
}

function humanize(value: string): string {
  const spaced = value
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim();
  return spaced.length === 0 ? value : `${spaced[0]?.toUpperCase() ?? ""}${spaced.slice(1)}`;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
}

function formatMeasure(value: number | string, unit?: string, currency?: string): string {
  const formatted = typeof value === "number" ? formatNumber(value) : value;
  if (currency) return `${currency} ${formatted}`;
  return unit ? `${formatted} ${unit}` : formatted;
}

function ratio(value: number, max: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) return 0;
  return Math.min(1, Math.max(0, value / max));
}

function SurfacePanel({
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

function SurfaceAlert({
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

function ActionButton(props: {
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

function SurfaceChoices({
  artifact,
  props,
  onInteraction,
  actionHandleFor,
}: {
  readonly artifact: SurfaceArtifact;
  readonly props: Record<string, unknown>;
  readonly onInteraction?: SurfaceWebProps["onInteraction"];
  readonly actionHandleFor?: SurfaceWebProps["actionHandleFor"];
}) {
  const [selected, setSelected] = useState<string>();
  const choices = props.choices as Array<{ label: string; value: string }>;
  const action = props.action as SurfaceAction;
  const questionId = `surface-${artifact.id}-question`;

  return (
    <section data-surface-choices aria-labelledby={questionId}>
      <header data-surface-choices-header>
        <span data-surface-eyebrow>Select one</span>
        <h3 id={questionId}>{String(props.question)}</h3>
      </header>
      <div data-surface-choice-list>
        {choices.map((choice) => (
          <ActionButton
            key={choice.value}
            label={choice.label}
            action={{ ...action, payload: { ...action.payload, value: choice.value } }}
            disabled={selected !== undefined}
            selected={selected === choice.value}
            onInteraction={async (handle, input) => {
              setSelected(choice.value);
              try {
                await onInteraction?.(handle, input);
              } catch {
                setSelected(undefined);
              }
            }}
            actionHandleFor={actionHandleFor}
          />
        ))}
      </div>
    </section>
  );
}

function SurfaceMultiChoice({
  artifact,
  props,
  onInteraction,
  actionHandleFor,
}: {
  readonly artifact: SurfaceArtifact;
  readonly props: Record<string, unknown>;
  readonly onInteraction?: SurfaceWebProps["onInteraction"];
  readonly actionHandleFor?: SurfaceWebProps["actionHandleFor"];
}) {
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [submitted, setSubmitted] = useState(false);
  const choices = props.choices as Array<{ label: string; value: string }>;
  const action = props.action as SurfaceAction;
  const handle = actionHandleFor?.(action);
  const questionId = `surface-${artifact.id}-question`;
  const toggle = (value: string) => {
    setSelected((previous) =>
      previous.includes(value) ? previous.filter((item) => item !== value) : [...previous, value]
    );
  };
  const submit = () => {
    setSubmitted(true);
    if (handle) void onInteraction?.(handle, { ...action.payload, values: selected });
  };

  return (
    <section data-surface-multi-choice aria-labelledby={questionId}>
      <header data-surface-choices-header>
        <span data-surface-eyebrow>Select any</span>
        <h3 id={questionId}>{String(props.question)}</h3>
      </header>
      <div data-surface-choice-list>
        {choices.map((choice) => (
          <label key={choice.value} data-surface-checkbox>
            <input
              type="checkbox"
              disabled={submitted}
              checked={selected.includes(choice.value)}
              onChange={() => toggle(choice.value)}
            />
            <span>{choice.label}</span>
          </label>
        ))}
      </div>
      <footer data-surface-form-footer>
        <button
          type="button"
          disabled={submitted || !handle || selected.length === 0}
          data-surface-button
          data-variant="primary"
          onClick={submit}
        >
          <span>Submit</span>
        </button>
      </footer>
    </section>
  );
}

function SurfaceForm({
  props,
  onInteraction,
  actionHandleFor,
}: {
  readonly props: Record<string, unknown>;
  readonly onInteraction?: SurfaceWebProps["onInteraction"];
  readonly actionHandleFor?: SurfaceWebProps["actionHandleFor"];
}) {
  const formId = useId();
  const [values, setValues] = useState<Record<string, unknown>>({});
  const fields = props.fields as Array<Record<string, unknown>>;
  const action = props.action as SurfaceAction;
  const handle = actionHandleFor?.(action);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (handle) void onInteraction?.(handle, values);
  };
  const update = (name: string, value: unknown) => {
    setValues((previous) => ({ ...previous, [name]: value }));
  };

  return (
    <form data-surface-form onSubmit={submit}>
      <header data-surface-panel-header>
        <div data-surface-panel-heading>
          <span data-surface-eyebrow>Input requested</span>
          <h3>{typeof props.title === "string" ? props.title : "Provide details"}</h3>
        </div>
        <span data-surface-panel-meta>
          {fields.length} {fields.length === 1 ? "field" : "fields"}
        </span>
      </header>
      <div data-surface-form-fields>
        {fields.map((field) => {
          const name = String(field.name);
          const fieldId = `${formId}-${name}`;
          const input = String(field.input);
          const label = String(field.label);
          const required = field.required === true;
          const options = Array.isArray(field.options)
            ? field.options.filter((option): option is string => typeof option === "string")
            : [];

          if (input === "checkbox") {
            return (
              <label key={name} htmlFor={fieldId} data-surface-checkbox>
                <input
                  id={fieldId}
                  name={name}
                  type="checkbox"
                  required={required}
                  onChange={(event) => update(name, event.target.checked)}
                />
                <span>
                  {label}
                  {required ? <small data-surface-required>required</small> : null}
                </span>
              </label>
            );
          }

          if (input === "radio") {
            return (
              <fieldset key={name} data-surface-radio-group>
                <legend>
                  {label}
                  {required ? <small data-surface-required>required</small> : null}
                </legend>
                {options.map((option) => (
                  <label key={option} htmlFor={`${fieldId}-${option}`} data-surface-radio>
                    <input
                      id={`${fieldId}-${option}`}
                      name={name}
                      type="radio"
                      value={option}
                      required={required}
                      onChange={() => update(name, option)}
                    />
                    <span>{option}</span>
                  </label>
                ))}
              </fieldset>
            );
          }

          if (input === "multiselect") {
            return (
              <label key={name} htmlFor={fieldId} data-surface-field>
                <span>
                  {label}
                  {required ? <small data-surface-required>required</small> : null}
                </span>
                <select
                  id={fieldId}
                  name={name}
                  required={required}
                  multiple
                  onChange={(event: ChangeEvent<HTMLSelectElement>) =>
                    update(
                      name,
                      Array.from(event.target.selectedOptions, (option) => option.value)
                    )
                  }
                >
                  {options.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </label>
            );
          }

          let control: ReactElement;
          if (input === "textarea") {
            control = (
              <textarea
                id={fieldId}
                name={name}
                required={required}
                rows={4}
                onChange={(event: ChangeEvent<HTMLTextAreaElement>) =>
                  update(name, event.target.value)
                }
              />
            );
          } else if (input === "select") {
            control = (
              <select
                id={fieldId}
                name={name}
                required={required}
                defaultValue=""
                onChange={(event: ChangeEvent<HTMLSelectElement>) =>
                  update(name, event.target.value)
                }
              >
                <option value="" disabled>
                  Select an option
                </option>
                {options.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            );
          } else {
            control = (
              <input
                id={fieldId}
                name={name}
                type={input}
                required={required}
                onChange={(event: ChangeEvent<HTMLInputElement>) =>
                  update(
                    name,
                    input === "number" && event.target.value !== ""
                      ? Number(event.target.value)
                      : event.target.value
                  )
                }
              />
            );
          }

          return (
            <label key={name} htmlFor={fieldId} data-surface-field>
              <span>
                {label}
                {required ? <small data-surface-required>required</small> : null}
              </span>
              {control}
            </label>
          );
        })}
      </div>
      <footer data-surface-form-footer>
        <ActionButton
          label={String(props.submit)}
          action={action}
          actionHandleFor={actionHandleFor}
          primary
          submit
        />
      </footer>
    </form>
  );
}

function chartDomain(series: readonly ChartSeries[]): { min: number; max: number } {
  const values = series.flatMap((item) => [...item.values]).filter(Number.isFinite);
  if (values.length === 0) return { min: 0, max: 1 };
  const min = Math.min(0, ...values);
  const max = Math.max(0, ...values);
  return min === max ? { min, max: min + 1 } : { min, max };
}

function ChartGrid({
  min,
  max,
  width,
  height,
  left,
  top,
  bottom,
}: {
  readonly min: number;
  readonly max: number;
  readonly width: number;
  readonly height: number;
  readonly left: number;
  readonly top: number;
  readonly bottom: number;
}) {
  const plotHeight = height - top - bottom;
  return (
    <g data-surface-chart-grid>
      {[0, 1, 2, 3, 4].map((index) => {
        const ratio = index / 4;
        const y = top + plotHeight * ratio;
        const value = max - (max - min) * ratio;
        return (
          <g key={index}>
            <line x1={left} x2={width - 16} y1={y} y2={y} />
            <text x={left - 8} y={y + 4} textAnchor="end">
              {formatNumber(value)}
            </text>
          </g>
        );
      })}
    </g>
  );
}

function SurfaceMetric({ props }: { readonly props: Record<string, unknown> }) {
  const cells = props.cells as MetricCell[];
  return (
    <SurfacePanel
      kind="metric"
      eyebrow="Metrics"
      meta={`${cells.length} ${cells.length === 1 ? "metric" : "metrics"}`}
    >
      <div data-surface-metric-grid>
        {cells.map((cell) => (
          <article key={cell.label} data-surface-metric-cell>
            <span data-surface-metric-label>{cell.label}</span>
            <strong data-surface-metric-value data-surface-mono>
              {formatMeasure(cell.value, cell.unit)}
            </strong>
            {cell.delta ? (
              <span data-surface-metric-delta data-delta-direction={cell.delta.direction}>
                <span data-surface-mono>{formatMeasure(cell.delta.value)}</span>
                {cell.delta.label ? <span>{cell.delta.label}</span> : null}
              </span>
            ) : null}
            {cell.caption ? <p data-surface-metric-caption>{cell.caption}</p> : null}
          </article>
        ))}
      </div>
    </SurfacePanel>
  );
}

function SurfaceTimeline({ props }: { readonly props: Record<string, unknown> }) {
  const entries = props.entries as TimelineEntry[];
  return (
    <SurfacePanel
      kind="timeline"
      eyebrow="Timeline"
      meta={`${entries.length} ${entries.length === 1 ? "event" : "events"}`}
    >
      <ol data-surface-timeline>
        {entries.map((entry, index) => (
          <li key={`${entry.label}-${index}`}>
            <div data-surface-timeline-marker aria-hidden="true" />
            <div data-surface-timeline-content>
              <header>
                <div>
                  {entry.timestamp ? <time>{entry.timestamp}</time> : null}
                  <strong>{entry.label}</strong>
                </div>
                {entry.status ? (
                  <span data-surface-status data-tone="neutral">
                    {entry.status}
                  </span>
                ) : null}
              </header>
              {entry.description ? <p>{entry.description}</p> : null}
            </div>
          </li>
        ))}
      </ol>
    </SurfacePanel>
  );
}

function SurfaceComparison({ props }: { readonly props: Record<string, unknown> }) {
  const options = props.options as ComparisonOption[];
  const criteria = props.criteria as ComparisonCriterion[];
  const cells = props.cells as ComparisonCell[];
  const cellMap = new Map(cells.map((cell) => [`${cell.criterion}:${cell.option}`, cell]));
  return (
    <SurfacePanel
      kind="comparison"
      eyebrow="Comparison"
      meta={`${options.length} options · ${criteria.length} criteria`}
    >
      <div data-surface-table-scroll>
        <table data-surface-comparison>
          <thead>
            <tr>
              <th scope="col">Criteria</th>
              {options.map((option) => (
                <th key={option.id} scope="col">
                  <span>{option.label}</span>
                  {option.recommended ? <span data-surface-recommended>Recommended</span> : null}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {criteria.map((criterion) => (
              <tr key={criterion.id}>
                <th scope="row">
                  <span>{criterion.label}</span>
                  {criterion.description ? <small>{criterion.description}</small> : null}
                </th>
                {options.map((option) => {
                  const cell = cellMap.get(`${criterion.id}:${option.id}`);
                  return (
                    <td key={option.id}>
                      <span>{cell ? string(cell.value) : "—"}</span>
                      {cell?.note ? <small>{cell.note}</small> : null}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </SurfacePanel>
  );
}

function SurfaceBreakdown({ props }: { readonly props: Record<string, unknown> }) {
  const segments = props.segments as BreakdownSegment[];
  const sum = segments.reduce((total, segment) => total + segment.value, 0);
  const explicitTotal = typeof props.total === "number" ? props.total : undefined;
  const total = explicitTotal ?? sum;
  const unit = typeof props.unit === "string" ? props.unit : undefined;
  const currency = typeof props.currency === "string" ? props.currency : undefined;
  return (
    <SurfacePanel
      kind="breakdown"
      eyebrow="Breakdown"
      meta={`Total ${formatMeasure(total, unit, currency)}`}
    >
      <div data-surface-breakdown>
        <div data-surface-breakdown-bar aria-hidden="true">
          {segments.map((segment, index) => (
            <span
              key={segment.label}
              data-series-color={index % 8}
              style={{ width: `${ratio(segment.value, total) * 100}%` }}
            />
          ))}
        </div>
        <dl data-surface-breakdown-list>
          {segments.map((segment, index) => {
            const percent = ratio(segment.value, total) * 100;
            return (
              <div key={segment.label}>
                <dt>
                  <i data-series-color={index % 8} />
                  <span>{segment.label}</span>
                </dt>
                <dd>
                  <span data-surface-mono>{formatMeasure(segment.value, unit, currency)}</span>
                  <span>{formatNumber(percent)}%</span>
                </dd>
              </div>
            );
          })}
        </dl>
      </div>
    </SurfacePanel>
  );
}

function SurfaceGauge({ props }: { readonly props: Record<string, unknown> }) {
  const value = typeof props.value === "number" ? props.value : 0;
  const max = typeof props.max === "number" ? props.max : 1;
  const target = typeof props.target === "number" ? props.target : undefined;
  const unit = typeof props.unit === "string" ? props.unit : undefined;
  const progress = ratio(value, max);
  const targetPosition = target === undefined ? undefined : ratio(target, max);
  const progressStyle: CSSProperties = { width: `${progress * 100}%` };
  const targetStyle: CSSProperties | undefined =
    targetPosition === undefined ? undefined : { left: `${targetPosition * 100}%` };

  return (
    <SurfacePanel
      kind="gauge"
      eyebrow="Gauge"
      title={typeof props.label === "string" ? props.label : "Progress"}
      meta={`${formatMeasure(value, unit)} / ${formatMeasure(max, unit)}`}
    >
      <div data-surface-gauge>
        <meter
          data-surface-sr-only
          min={0}
          max={max}
          value={value}
          aria-label={typeof props.label === "string" ? props.label : "Progress"}
        />
        <div data-surface-gauge-track aria-hidden="true">
          <span data-surface-gauge-fill style={progressStyle} />
          {targetStyle ? (
            <span
              data-surface-gauge-target
              style={targetStyle}
              title={`Target ${formatMeasure(target ?? 0, unit)}`}
            />
          ) : null}
        </div>
        <div data-surface-gauge-labels>
          <span data-surface-mono>{formatMeasure(value, unit)}</span>
          {target !== undefined ? <span>Target {formatMeasure(target, unit)}</span> : null}
          <span data-surface-mono>{formatMeasure(max, unit)}</span>
        </div>
      </div>
    </SurfacePanel>
  );
}

function SurfaceChart({ props }: { readonly props: Record<string, unknown> }) {
  const kind = props.kind === "line" ? "line" : "bar";
  const labels = props.labels as string[];
  const series = props.series as ChartSeries[];
  const width = 640;
  const height = 280;
  const left = 56;
  const right = 16;
  const top = 20;
  const bottom = 54;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const { min, max } = chartDomain(series);
  const y = (value: number) => top + ((max - value) / (max - min)) * plotHeight;
  const baseline = y(0);
  const groupWidth = plotWidth / Math.max(labels.length, 1);
  const labelStep = Math.max(1, Math.ceil(labels.length / 8));
  const lineX = (index: number) =>
    labels.length === 1 ? left + plotWidth / 2 : left + (index / (labels.length - 1)) * plotWidth;
  const barX = (index: number) => left + index * groupWidth + groupWidth / 2;
  const labelX = (index: number) => (kind === "line" ? lineX(index) : barX(index));

  return (
    <SurfacePanel
      kind="chart"
      eyebrow="Chart"
      title={`${humanize(kind)} chart`}
      meta={`${series.length} series`}
    >
      <figure data-surface-visual>
        <div data-surface-legend>
          {series.map((item, index) => (
            <span key={item.label} data-series-color={index % 8}>
              <i />
              {item.label}
            </span>
          ))}
        </div>
        <svg
          data-surface-chart
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label={`${humanize(kind)} chart showing ${series.map((item) => item.label).join(", ")}`}
        >
          <ChartGrid
            min={min}
            max={max}
            width={width}
            height={height}
            left={left}
            top={top}
            bottom={bottom}
          />
          {kind === "bar"
            ? labels.flatMap((label, labelIndex) => {
                const barWidth = Math.max(
                  2,
                  Math.min(24, (groupWidth - 12) / Math.max(series.length, 1))
                );
                const groupBarsWidth = barWidth * series.length;
                const groupStart =
                  left + labelIndex * groupWidth + (groupWidth - groupBarsWidth) / 2;
                return series.map((item, seriesIndex) => {
                  const value = item.values[labelIndex] ?? 0;
                  const valueY = y(value);
                  return (
                    <rect
                      key={`${label}-${item.label}`}
                      data-series-color={seriesIndex % 8}
                      x={groupStart + seriesIndex * barWidth}
                      y={Math.min(valueY, baseline)}
                      width={Math.max(1, barWidth - 2)}
                      height={Math.max(1, Math.abs(baseline - valueY))}
                      rx={1}
                    >
                      <title>{`${label}, ${item.label}: ${formatNumber(value)}`}</title>
                    </rect>
                  );
                });
              })
            : series.map((item, seriesIndex) => {
                const points = labels.map((label, index) => {
                  const value = item.values[index] ?? 0;
                  return { label, value, x: lineX(index), y: y(value) };
                });
                const path = points
                  .map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`)
                  .join(" ");
                return (
                  <g key={item.label} data-series-color={seriesIndex % 8}>
                    <path d={path} data-surface-chart-line />
                    {points.length <= 24
                      ? points.map((point) => (
                          <circle
                            key={point.label}
                            cx={point.x}
                            cy={point.y}
                            r={3}
                            data-surface-chart-point
                          >
                            <title>{`${point.label}, ${item.label}: ${formatNumber(point.value)}`}</title>
                          </circle>
                        ))
                      : null}
                  </g>
                );
              })}
          <g data-surface-chart-labels>
            {labels.map((label, index) =>
              index % labelStep === 0 || index === labels.length - 1 ? (
                <text key={label} x={labelX(index)} y={height - 20} textAnchor="middle">
                  {label}
                </text>
              ) : null
            )}
          </g>
        </svg>
        <table data-surface-sr-only>
          <caption>{`${humanize(kind)} chart data`}</caption>
          <thead>
            <tr>
              <th>Label</th>
              {series.map((item) => (
                <th key={item.label}>{item.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {labels.map((label, index) => (
              <tr key={label}>
                <th>{label}</th>
                {series.map((item) => (
                  <td key={item.label}>{formatNumber(item.values[index] ?? 0)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </figure>
    </SurfacePanel>
  );
}

function SurfaceForceGraph({ props }: { readonly props: Record<string, unknown> }) {
  const nodes = props.nodes as GraphNode[];
  const edges = props.edges as GraphEdge[];
  const width = 640;
  const height = 360;
  const centerX = width / 2;
  const centerY = height / 2;
  const radius = Math.min(width, height) * 0.36;
  const positions = new Map(
    nodes.map((node, index) => {
      if (nodes.length === 1) return [node.id, { x: centerX, y: centerY }] as const;
      const angle = (index / Math.max(nodes.length, 1)) * Math.PI * 2 - Math.PI / 2;
      return [
        node.id,
        {
          x: centerX + Math.cos(angle) * radius,
          y: centerY + Math.sin(angle) * radius,
        },
      ] as const;
    })
  );

  return (
    <SurfacePanel
      kind="force-graph"
      eyebrow="Relationship map"
      title="Connected records"
      meta={`${nodes.length} nodes · ${edges.length} edges`}
    >
      <figure data-surface-visual>
        <svg
          data-surface-force-graph
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label={`Relationship graph with ${nodes.length} nodes and ${edges.length} edges`}
        >
          <g data-surface-graph-edges>
            {edges.map((edge, index) => {
              const source = positions.get(edge.source);
              const target = positions.get(edge.target);
              if (!source || !target) return null;
              return (
                <line
                  key={`${edge.source}-${edge.target}-${index}`}
                  x1={source.x}
                  y1={source.y}
                  x2={target.x}
                  y2={target.y}
                >
                  <title>{`${edge.source} to ${edge.target}`}</title>
                </line>
              );
            })}
          </g>
          <g data-surface-graph-nodes>
            {nodes.map((node, index) => {
              const point = positions.get(node.id);
              if (!point) return null;
              return (
                <g
                  key={node.id}
                  transform={`translate(${point.x} ${point.y})`}
                  data-series-color={index % 8}
                >
                  <circle r={nodes.length > 40 ? 5 : 8}>
                    <title>{node.label ?? node.id}</title>
                  </circle>
                  {nodes.length <= 40 ? (
                    <text y={-14} textAnchor="middle">
                      {node.label ?? node.id}
                    </text>
                  ) : null}
                </g>
              );
            })}
          </g>
        </svg>
        <ul data-surface-sr-only>
          {nodes.map((node) => (
            <li key={node.id}>{node.label ?? node.id}</li>
          ))}
        </ul>
      </figure>
    </SurfacePanel>
  );
}

function renderSurfaceContent({
  artifact,
  onInteraction,
  actionHandleFor,
}: SurfaceWebProps): ReactElement {
  const props = artifact.props as Record<string, unknown>;
  switch (artifact.component.name) {
    case "Text":
      return (
        <p data-surface-text data-tone={String(props.tone ?? "neutral")}>
          {String(props.text)}
        </p>
      );
    case "Heading": {
      if (props.level === 1) {
        return (
          <h1 data-surface-heading data-level={1}>
            {String(props.text)}
          </h1>
        );
      }
      if (props.level === 3) {
        return (
          <h3 data-surface-heading data-level={3}>
            {String(props.text)}
          </h3>
        );
      }
      return (
        <h2 data-surface-heading data-level={2}>
          {String(props.text)}
        </h2>
      );
    }
    case "Section":
      return (
        <SurfacePanel
          kind="section"
          eyebrow="Section"
          title={typeof props.heading === "string" ? props.heading : undefined}
        >
          <p data-surface-body-copy>{String(props.body)}</p>
        </SurfacePanel>
      );
    case "Card":
      return (
        <SurfacePanel
          kind="card"
          eyebrow="Summary"
          title={typeof props.title === "string" ? props.title : undefined}
          meta={
            typeof props.status === "string" ? (
              <span data-surface-status data-tone="neutral">
                {props.status}
              </span>
            ) : undefined
          }
        >
          <p data-surface-body-copy>{String(props.body)}</p>
        </SurfacePanel>
      );
    case "Status":
      return (
        <span role="status" data-surface-status data-tone={String(props.tone ?? "neutral")}>
          {String(props.label)}
        </span>
      );
    case "Alert": {
      const severity = String(props.severity ?? "info");
      return (
        <SurfaceAlert
          severity={severity}
          eyebrow={humanize(severity)}
          title={typeof props.title === "string" ? props.title : undefined}
          message={String(props.message)}
        />
      );
    }
    case "List": {
      const items = props.items as string[];
      const ordered = props.ordered === true;
      const listItems = items.map((item, index) => <li key={`${item}-${index}`}>{item}</li>);
      const list = ordered ? (
        <ol data-surface-list>{listItems}</ol>
      ) : (
        <ul data-surface-list>{listItems}</ul>
      );
      return (
        <SurfacePanel
          kind="list"
          eyebrow={ordered ? "Sequence" : "List"}
          meta={`${items.length} ${items.length === 1 ? "item" : "items"}`}
        >
          {list}
        </SurfacePanel>
      );
    }
    case "RecordDetail": {
      const record = props.record as Record<string, unknown>;
      return (
        <SurfacePanel
          kind="record-detail"
          eyebrow="Record"
          title={typeof props.title === "string" ? props.title : "Details"}
          meta={`${Object.keys(record).length} fields`}
        >
          <dl data-surface-record-detail>
            {Object.entries(record).map(([key, value]) => (
              <div key={key}>
                <dt>{humanize(key)}</dt>
                <dd>{string(value)}</dd>
              </div>
            ))}
          </dl>
        </SurfacePanel>
      );
    }
    case "RecordTable": {
      const columns = props.columns as string[];
      const records = props.records as Array<Record<string, unknown>>;
      return (
        <SurfacePanel
          kind="record-table"
          eyebrow="Records"
          meta={`${records.length} ${records.length === 1 ? "row" : "rows"}`}
        >
          <div data-surface-table-scroll>
            <table data-surface-record-table>
              <thead>
                <tr>
                  {columns.map((column) => (
                    <th key={column} scope="col">
                      {humanize(column)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {records.map((record, row) => (
                  <tr key={`${artifact.id}-${row}`}>
                    {columns.map((column) => (
                      <td key={column}>{string(record[column])}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </SurfacePanel>
      );
    }
    case "Actions": {
      const actions = props.actions as Array<{ label: string; action: SurfaceAction }>;
      return (
        <SurfacePanel
          kind="actions"
          eyebrow="Available actions"
          meta={`${actions.length} ${actions.length === 1 ? "action" : "actions"}`}
        >
          <div data-surface-actions>
            {actions.map(({ label, action }, index) => (
              <ActionButton
                key={`${label}-${action.event}`}
                label={label}
                action={action}
                onInteraction={onInteraction}
                actionHandleFor={actionHandleFor}
                primary={index === 0}
              />
            ))}
          </div>
        </SurfacePanel>
      );
    }
    case "Choices":
      return (
        <SurfaceChoices
          artifact={artifact}
          props={props}
          onInteraction={onInteraction}
          actionHandleFor={actionHandleFor}
        />
      );
    case "Form":
      return (
        <SurfaceForm
          props={props}
          onInteraction={onInteraction}
          actionHandleFor={actionHandleFor}
        />
      );
    case "Divider":
      return <hr data-surface-divider />;
    case "Image":
      return (
        <figure data-surface-image>
          <img src={String(props.url)} alt={String(props.altText)} data-surface-image-media />
          {typeof props.title === "string" ? <figcaption>{props.title}</figcaption> : null}
        </figure>
      );
    case "MultiChoice":
      return (
        <SurfaceMultiChoice
          artifact={artifact}
          props={props}
          onInteraction={onInteraction}
          actionHandleFor={actionHandleFor}
        />
      );
    case "Metric":
      return <SurfaceMetric props={props} />;
    case "Timeline":
      return <SurfaceTimeline props={props} />;
    case "Comparison":
      return <SurfaceComparison props={props} />;
    case "Breakdown":
      return <SurfaceBreakdown props={props} />;
    case "Gauge":
      return <SurfaceGauge props={props} />;
    case "Chart":
      return <SurfaceChart props={props} />;
    case "ForceGraph":
      return <SurfaceForceGraph props={props} />;
    default:
      return (
        <SurfaceAlert
          severity="error"
          eyebrow="Unsupported"
          message="This presentation component is unavailable."
        />
      );
  }
}

export function SurfaceView({
  artifact,
  onInteraction,
  actionHandleFor,
}: SurfaceWebProps): ReactElement {
  return (
    <div
      data-surface-artifact={artifact.id}
      data-surface-revision={artifact.revision}
      data-surface-component={artifact.component.name}
    >
      {renderSurfaceContent({ artifact, onInteraction, actionHandleFor })}
    </div>
  );
}

function CompositionNode({
  artifact,
  view,
  onInteraction,
  actionHandleFor,
  path,
}: SurfaceCompositionProps & { readonly path: string }): ReactElement {
  const projected: SurfaceArtifact = {
    ...artifact,
    component: view.component,
    props: view.props,
  };
  return (
    <div data-surface-node={path}>
      <SurfaceView
        artifact={projected}
        onInteraction={onInteraction}
        actionHandleFor={actionHandleFor}
      />
      {view.children?.map((child, index) => (
        <CompositionNode
          key={`${path}-${child.component.name}-${index}`}
          artifact={artifact}
          view={child}
          onInteraction={onInteraction}
          actionHandleFor={actionHandleFor}
          path={`${path}.${index}`}
        />
      ))}
    </div>
  );
}

export function SurfaceCompositionView(props: SurfaceCompositionProps): ReactElement {
  return <CompositionNode {...props} path="0" />;
}

const target = { channel: "web", surface: "chat" } as const;

export const surfaceWebRenderer: SurfaceRenderer<ReactElement> = {
  target,
  manifest: surfaceWebManifest,
  preflight: (artifact) => [
    ...validateSurfaceArtifact(artifact, [], surfaceWebManifest),
    ...(!sameTarget(artifact.target, target)
      ? [
          {
            code: "component_unsupported" as const,
            path: "/target",
            message: "Artifact target does not match the web renderer.",
          },
        ]
      : []),
  ],
  render: (artifact, context) => {
    const issues = surfaceWebRenderer.preflight(artifact);
    if (issues.length > 0) throw new Error(issues.map((issue) => issue.message).join("; "));
    return <SurfaceView artifact={artifact} actionHandleFor={context.actionHandleFor} />;
  },
  update: (_previous, artifact, context) => surfaceWebRenderer.render(artifact, context),
};

export { targetKey };
