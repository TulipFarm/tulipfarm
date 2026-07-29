import {
  type ResolvedSurfaceViewNode,
  type SurfaceAction,
  type SurfaceArtifact,
  type SurfaceRenderer,
  sameTarget,
  targetKey,
  validateSurfaceArtifact,
} from "@tulipfarm/surface";
import type { ChangeEvent, FormEvent, ReactElement, ReactNode } from "react";
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

          return (
            <label key={name} htmlFor={fieldId} data-surface-field>
              <span>
                {label}
                {required ? <small data-surface-required>required</small> : null}
              </span>
              {input === "textarea" ? (
                <textarea
                  id={fieldId}
                  name={name}
                  required={required}
                  rows={4}
                  onChange={(event: ChangeEvent<HTMLTextAreaElement>) =>
                    update(name, event.target.value)
                  }
                />
              ) : input === "select" ? (
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
              ) : (
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
              )}
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
  const labelX = (index: number) =>
    kind === "line"
      ? labels.length === 1
        ? left + plotWidth / 2
        : left + (index / (labels.length - 1)) * plotWidth
      : left + index * groupWidth + groupWidth / 2;

  return (
    <SurfacePanel
      kind="chart"
      eyebrow="Chart"
      title={`${humanize(kind)} chart`}
      meta={`${series.length} ${series.length === 1 ? "series" : "series"}`}
    >
      <figure data-surface-visual>
        <div data-surface-legend>
          {series.map((item, index) => (
            <span key={item.label} data-series-color={index % 7}>
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
                      data-series-color={seriesIndex % 7}
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
                  const x =
                    labels.length === 1
                      ? left + plotWidth / 2
                      : left + (index / (labels.length - 1)) * plotWidth;
                  const value = item.values[index] ?? 0;
                  return { label, value, x, y: y(value) };
                });
                const path = points
                  .map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`)
                  .join(" ");
                return (
                  <g key={item.label} data-series-color={seriesIndex % 7}>
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
                  data-series-color={index % 7}
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

export function SurfaceView({
  artifact,
  onInteraction,
  actionHandleFor,
}: SurfaceWebProps): ReactElement {
  const props = artifact.props as Record<string, unknown>;
  const name = artifact.component.name;
  let content: ReactElement;
  switch (name) {
    case "Text":
      content = (
        <p data-surface-text data-tone={String(props.tone ?? "neutral")}>
          {String(props.text)}
        </p>
      );
      break;
    case "Heading": {
      const level = props.level === 1 ? 1 : props.level === 3 ? 3 : 2;
      content =
        level === 1 ? (
          <h1 data-surface-heading data-level={level}>
            {String(props.text)}
          </h1>
        ) : level === 3 ? (
          <h3 data-surface-heading data-level={level}>
            {String(props.text)}
          </h3>
        ) : (
          <h2 data-surface-heading data-level={level}>
            {String(props.text)}
          </h2>
        );
      break;
    }
    case "Section":
      content = (
        <SurfacePanel
          kind="section"
          eyebrow="Section"
          title={typeof props.heading === "string" ? props.heading : undefined}
        >
          <p data-surface-body-copy>{String(props.body)}</p>
        </SurfacePanel>
      );
      break;
    case "Card":
      content = (
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
      break;
    case "Status":
      content = (
        <span role="status" data-surface-status data-tone={String(props.tone ?? "neutral")}>
          {String(props.label)}
        </span>
      );
      break;
    case "Alert": {
      const severity = String(props.severity ?? "info");
      content = (
        <div role="alert" data-surface-alert data-severity={severity}>
          <div data-surface-alert-marker aria-hidden="true" />
          <div data-surface-alert-content>
            <span data-surface-eyebrow>{humanize(severity)}</span>
            {typeof props.title === "string" ? <strong>{props.title}</strong> : null}
            <p>{String(props.message)}</p>
          </div>
        </div>
      );
      break;
    }
    case "List": {
      const items = props.items as string[];
      const ordered = props.ordered === true;
      const list = ordered ? (
        <ol data-surface-list>
          {items.map((item, index) => (
            <li key={`${item}-${index}`}>{item}</li>
          ))}
        </ol>
      ) : (
        <ul data-surface-list>
          {items.map((item, index) => (
            <li key={`${item}-${index}`}>{item}</li>
          ))}
        </ul>
      );
      content = (
        <SurfacePanel
          kind="list"
          eyebrow={ordered ? "Sequence" : "List"}
          meta={`${items.length} ${items.length === 1 ? "item" : "items"}`}
        >
          {list}
        </SurfacePanel>
      );
      break;
    }
    case "RecordDetail": {
      const record = props.record as Record<string, unknown>;
      content = (
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
      break;
    }
    case "RecordTable": {
      const columns = props.columns as string[];
      const records = props.records as Array<Record<string, unknown>>;
      content = (
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
      break;
    }
    case "Actions": {
      const actions = props.actions as Array<{ label: string; action: SurfaceAction }>;
      content = (
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
      break;
    }
    case "Choices":
      content = (
        <SurfaceChoices
          artifact={artifact}
          props={props}
          onInteraction={onInteraction}
          actionHandleFor={actionHandleFor}
        />
      );
      break;
    case "Form":
      content = (
        <SurfaceForm
          props={props}
          onInteraction={onInteraction}
          actionHandleFor={actionHandleFor}
        />
      );
      break;
    case "Chart":
      content = <SurfaceChart props={props} />;
      break;
    case "ForceGraph":
      content = <SurfaceForceGraph props={props} />;
      break;
    default:
      content = (
        <div role="alert" data-surface-alert data-severity="error">
          <div data-surface-alert-marker aria-hidden="true" />
          <div data-surface-alert-content>
            <span data-surface-eyebrow>Unsupported</span>
            <p>This presentation component is unavailable.</p>
          </div>
        </div>
      );
  }
  return (
    <div
      data-surface-artifact={artifact.id}
      data-surface-revision={artifact.revision}
      data-surface-component={name}
    >
      {content}
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
