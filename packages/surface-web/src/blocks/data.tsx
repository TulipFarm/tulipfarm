/** Data-visualization blocks: read-only projections of numeric props, with an accessible fallback. */

import type { CSSProperties } from "react";
import { formatMeasure, formatNumber, humanize, ratio, SurfacePanel, string } from "../primitives";

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

export function SurfaceMetric({ props }: { readonly props: Record<string, unknown> }) {
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

export function SurfaceTimeline({ props }: { readonly props: Record<string, unknown> }) {
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

export function SurfaceComparison({ props }: { readonly props: Record<string, unknown> }) {
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

export function SurfaceBreakdown({ props }: { readonly props: Record<string, unknown> }) {
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

export function SurfaceGauge({ props }: { readonly props: Record<string, unknown> }) {
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

export function SurfaceChart({ props }: { readonly props: Record<string, unknown> }) {
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

export function SurfaceForceGraph({ props }: { readonly props: Record<string, unknown> }) {
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
