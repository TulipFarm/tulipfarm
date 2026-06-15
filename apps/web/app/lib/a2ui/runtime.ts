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
 *     { __a2ui: "swap", fragments }   — replace each [data-a2ui-id] node with its compiled fragment
 *     anything else                   — re-dispatched as CustomEvent("a2ui:message", { detail })
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

  // Host → frame: only accept the real parent. A "swap" applies compiled fragments in place (the host
  // pre-sanitises them); everything else is re-dispatched as a DOM event components subscribe to.
  window.addEventListener("message", function (event) {
    if (event.source !== parentWin) return;
    var data = event.data;
    if (data && data.__a2ui === "swap" && Array.isArray(data.fragments)) {
      for (var i = 0; i < data.fragments.length; i++) {
        var frag = data.fragments[i];
        if (!frag || typeof frag.nodeId !== "string" || typeof frag.html !== "string") continue;
        // Strip quotes/backslashes so the id cannot break out of the attribute selector.
        var id = frag.nodeId.replace(/["'\\\\]/g, "");
        var el = document.querySelector('[data-a2ui-id="' + id + '"]');
        if (el) el.outerHTML = frag.html;
      }
      return;
    }
    document.dispatchEvent(new CustomEvent("a2ui:message", { detail: data }));
  });

  // Interactivity bridge: tf-* controls are static (DOMPurify strips inline handlers), so clicks are
  // delegated here. A click on (or inside) an element carrying data-a2ui-send posts its JSON payload
  // out through the "agent" channel — the host turns it into a follow-up turn. An "a2ui-form" submit
  // first gathers the enclosing form's field values into payload.data (HITL). Malformed JSON no-ops.
  document.addEventListener("click", function (event) {
    var node = event.target;
    while (node && node !== document) {
      if (node.nodeType === 1 && node.hasAttribute("data-a2ui-send")) {
        try {
          var payload = JSON.parse(node.getAttribute("data-a2ui-send"));
          if (payload && payload.kind === "a2ui-form") {
            payload.data = gatherForm(node);
          }
          window.__a2ui.send("agent", payload);
        } catch (_e) {}
        return;
      }
      node = node.parentNode;
    }
  });

  // Collect [data-name] control values from the enclosing tf-schema-form (HITL submit). Checkboxes →
  // boolean; radios → the checked option's value; everything else → the control's value.
  function gatherForm(fromNode) {
    var form = fromNode;
    while (form && form !== document) {
      if (form.nodeType === 1 && form.tagName && form.tagName.toLowerCase() === "tf-schema-form") break;
      form = form.parentNode;
    }
    var data = {};
    if (!form || !form.querySelectorAll) return data;
    var controls = form.querySelectorAll("[data-name]");
    for (var i = 0; i < controls.length; i++) {
      var el = controls[i];
      var name = el.getAttribute("data-name");
      if (!name) continue;
      var type = (el.getAttribute("type") || "").toLowerCase();
      if (type === "checkbox") {
        data[name] = !!el.checked;
      } else if (type === "radio") {
        if (el.checked) data[name] = el.value;
      } else {
        data[name] = el.value;
      }
    }
    return data;
  }

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
