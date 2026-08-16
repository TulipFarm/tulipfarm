import {
  type SurfaceAction,
  type SurfaceArtifact,
  type SurfaceRenderer,
  sameTarget,
  targetKey,
  validateSurfaceArtifact,
} from "@tulipfarm/surface";
import type { ReactElement } from "react";
import {
  SurfaceBreakdown,
  SurfaceChart,
  SurfaceComparison,
  SurfaceForceGraph,
  SurfaceGauge,
  SurfaceMetric,
  SurfaceTimeline,
} from "./blocks/data";
import { SurfaceChoices, SurfaceForm, SurfaceMultiChoice } from "./blocks/input";
import { surfaceWebManifest } from "./manifest";
import {
  ActionButton,
  humanize,
  SurfaceAlert,
  type SurfaceCompositionProps,
  SurfacePanel,
  type SurfaceWebProps,
  string,
} from "./primitives";

export type { SurfaceCompositionProps, SurfaceWebProps } from "./primitives";

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
