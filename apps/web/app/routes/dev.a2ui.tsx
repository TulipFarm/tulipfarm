import { useCallback, useRef, useState } from "react";
import { A2uiFrame, type A2uiFrameHandle } from "~/components/a2ui-frame";

/**
 * DEV-only harness for the A2UI rendering foundation (`/dev/a2ui`). Mounts <A2uiFrame> with sample
 * content that exercises every guarantee — safe render, sanitize stripping, an unknown tf-* element,
 * a CSP-blocked external image — and surfaces host-side bridge traffic. The outbound bridge and
 * isolation are driven in a real browser (Playwright) via the iframe's `window.__a2ui` global.
 *
 * The route file is still bundled in prod, but this returns null unless `import.meta.env.DEV`, so
 * `/dev/a2ui` is an inert empty page outside development — no renderer is exposed.
 */
const SAMPLE_HTML = `
<tf-heading>A2UI component showcase</tf-heading>
<tf-heading data-variant="label">system</tf-heading>

<tf-text>Default body text — inherits the system monospace from the reset.</tf-text>
<tf-text data-tone="muted">Muted secondary text.</tf-text>
<tf-text data-tone="brand">Brand-toned text (ruby, used sparingly).</tf-text>
<tf-text data-tone="danger">Danger-toned text.</tf-text>
<tf-text data-size="xs">Extra-small annotation.</tf-text>

<p>
  <tf-badge>neutral</tf-badge>
  <tf-badge data-variant="brand">brand</tf-badge>
  <tf-badge data-variant="danger">danger</tf-badge>
  <tf-badge data-variant="outline">outline</tf-badge>
</p>

<tf-alert>Default neutral alert — informational message.</tf-alert>
<tf-alert data-tone="danger"><span data-slot="title">Error</span>Authentication required. Check your API token.</tf-alert>
<tf-alert data-tone="brand"><span data-slot="title">Info</span>3 tasks queued for processing.</tf-alert>

<tf-card>
  <tf-heading>Agent report</tf-heading>
  <tf-text data-tone="muted">Processed 42 records in the last run.</tf-text>
  <tf-badge data-variant="outline">last run: 2m ago</tf-badge>
</tf-card>

<tf-grid data-cols="3">
  <tf-metric-card data-trend="up">
    <span data-slot="value">1,284</span>
    <span data-slot="label">Records indexed</span>
    <span data-slot="delta">+12% vs last week</span>
  </tf-metric-card>
  <tf-metric-card data-trend="down">
    <span data-slot="value">3</span>
    <span data-slot="label">Failed syncs</span>
    <span data-slot="delta">+1 since yesterday</span>
  </tf-metric-card>
  <tf-metric-card data-trend="flat">
    <span data-slot="value">99.2%</span>
    <span data-slot="label">Uptime</span>
    <span data-slot="delta">no change</span>
  </tf-metric-card>
</tf-grid>

<tf-list>
  <ul>
    <li>task-001 — generate report<span data-slot="meta">done</span></li>
    <li>task-002 — sync contacts<span data-slot="meta">running</span></li>
    <li>task-003 — archive records<span data-slot="meta">queued</span></li>
  </ul>
</tf-list>

<tf-detail-view>
  <dl>
    <div><dt>id</dt><dd>a1b2c3d4-e5f6-7890-abcd-ef1234567890</dd></div>
    <div><dt>name</dt><dd>Production sync agent</dd></div>
    <div><dt>status</dt><dd>active</dd></div>
    <div><dt>model</dt><dd>claude-sonnet-4-6</dd></div>
  </dl>
</tf-detail-view>

<tf-data-table>
  <table>
    <thead>
      <tr>
        <th aria-sort="ascending">id</th>
        <th>name</th>
        <th>status</th>
        <th>priority</th>
        <th>updatedAt</th>
      </tr>
    </thead>
    <tbody>
      <tr><td><a href="#">TICK-1042</a></td><td>Login 500 on Safari</td><td>open</td><td>high</td><td>Jun 08, 2026</td></tr>
      <tr><td><a href="#">TICK-1043</a></td><td>Export CSV timeout</td><td>open</td><td>low</td><td>Jun 07, 2026</td></tr>
      <tr><td><a href="#">TICK-1044</a></td><td>Stale avatar cache</td><td>closed</td><td>low</td><td>Jun 05, 2026</td></tr>
    </tbody>
  </table>
</tf-data-table>

<tf-empty-state>
  <span data-slot="title">No results found</span>
  Run a query to see data here.
  <tf-button data-variant="outline" data-size="sm">Run query</tf-button>
</tf-empty-state>

<p>
  <tf-button>default</tf-button>
  <tf-button data-variant="secondary">secondary</tf-button>
  <tf-button data-variant="outline">outline</tf-button>
  <tf-button data-variant="ghost">ghost</tf-button>
  <tf-button data-variant="destructive">destructive</tf-button>
  <tf-button data-variant="link">link</tf-button>
</p>
<p>
  <tf-button data-size="sm">small</tf-button>
  <tf-button>default size</tf-button>
  <tf-button data-size="lg">large</tf-button>
</p>

<tf-kanban>this unknown element renders empty without crashing</tf-kanban>

<p style="color: var(--primary)" id="token-probe">token-driven color</p>
<p>plain <strong>safe</strong> markup</p>
<img src="https://example.com/should-be-blocked.png" alt="external (CSP should block)">
<script>window.__a2uiPwned = true;</script>
<div onclick="window.__a2uiPwned = true">inert</div>
`;

export default function DevA2ui() {
  const ref = useRef<A2uiFrameHandle>(null);
  const [received, setReceived] = useState<string[]>([]);

  const log = useCallback((channel: string, payload: unknown) => {
    setReceived((prev) => [...prev, `${channel}:${JSON.stringify(payload)}`]);
  }, []);

  if (!import.meta.env.DEV) return null;

  return (
    <main style={{ padding: 16, fontFamily: "ui-monospace, monospace" }}>
      <h1>A2UI dev harness</h1>
      <button
        type="button"
        data-testid="a2ui-send-in"
        onClick={() => ref.current?.send({ channel: "api", payload: { from: "host" } })}
      >
        send into frame
      </button>
      <ul data-testid="a2ui-received">
        {received.map((entry) => (
          <li key={entry}>{entry}</li>
        ))}
      </ul>
      <A2uiFrame
        ref={ref}
        html={SAMPLE_HTML}
        onAgent={(p) => log("agent", p)}
        onApi={(p) => log("api", p)}
        onNavigate={(p) => log("navigate", p)}
      />
    </main>
  );
}
