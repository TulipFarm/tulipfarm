/**
 * In-iframe runtime, injected into the srcdoc as a nonce'd <script>. Authored as an audited
 * STRING (not a value-imported module) so it survives bundling/minification unchanged and stays
 * fully self-contained (decision D5). Its envelope shapes must match protocol.ts exactly:
 *
 *   OUTBOUND  frame → parent   window.parent.postMessage(msg, "*")
 *     { channel, payload }            — via window.__a2ui.send(channel, payload) (future tf-* components)
 *     { __a2ui: "resize", height }    — rAF-batched on content resize
 *     { __a2ui: "ready" }             — once, after the document is parsed
 *   INBOUND   parent → frame   window "message" (accepted only when event.source === window.parent)
 *     re-dispatched as  document.dispatchEvent(new CustomEvent("a2ui:message", { detail }))
 *
 * The runtime cannot reach the parent DOM (the iframe is sandboxed without allow-same-origin);
 * postMessage is the only channel across the boundary.
 */
export const A2UI_RUNTIME = `(function () {
  var parentWin = window.parent;
  function post(msg) { parentWin.postMessage(msg, "*"); }

  // Future tf-* components call this to talk to the host.
  window.__a2ui = {
    send: function (channel, payload) {
      if (channel === "agent" || channel === "api" || channel === "navigate") {
        post({ channel: channel, payload: payload });
      }
    },
  };

  // Host → frame: only accept the real parent, then re-dispatch as a DOM event components subscribe to.
  window.addEventListener("message", function (event) {
    if (event.source !== parentWin) return;
    document.dispatchEvent(new CustomEvent("a2ui:message", { detail: event.data }));
  });

  // Interactivity bridge: tf-* controls are static (DOMPurify strips inline handlers), so clicks are
  // delegated here. A click on (or inside) an element carrying data-a2ui-send posts its JSON payload
  // out through the "agent" channel — the host turns it into a follow-up turn. Malformed JSON no-ops.
  document.addEventListener("click", function (event) {
    var node = event.target;
    while (node && node !== document) {
      if (node.nodeType === 1 && node.hasAttribute("data-a2ui-send")) {
        try {
          window.__a2ui.send("agent", JSON.parse(node.getAttribute("data-a2ui-send")));
        } catch (_e) {}
        return;
      }
      node = node.parentNode;
    }
  });

  // Auto-size: report content height, rAF-batched (outer-height only ⇒ no feedback loop).
  var pending = false;
  function reportHeight() {
    if (pending) return;
    pending = true;
    requestAnimationFrame(function () {
      pending = false;
      post({ __a2ui: "resize", height: document.documentElement.scrollHeight });
    });
  }
  if (typeof ResizeObserver === "function") {
    new ResizeObserver(reportHeight).observe(document.documentElement);
  }

  function ready() {
    post({ __a2ui: "ready" });
    reportHeight();
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", ready);
  } else {
    ready();
  }
})();`;
