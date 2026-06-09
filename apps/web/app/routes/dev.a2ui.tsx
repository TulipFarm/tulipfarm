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
<tf-card data-test="safe">
  <tf-heading>Hello from A2UI</tf-heading>
  <tf-text>Rendered inside a sandboxed iframe.</tf-text>
  <p style="color: var(--primary)" id="token-probe">token-driven color</p>
</tf-card>
<tf-kanban>this unknown element renders empty without crashing</tf-kanban>
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
