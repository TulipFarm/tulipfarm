/**
 * In-iframe chart bootstrap, injected into the srcdoc as a nonce'd <script> AFTER the Chart.js UMD
 * (which sets `window.Chart` and auto-registers the bar/line controllers). Injected only when the
 * sanitized HTML contains a `tf-chart-` element (see srcdoc.ts).
 *
 * Authored as an audited STRING (not a value-imported module) so it stays self-contained inside the
 * sandboxed frame and survives bundling unchanged — same contract as runtime.ts. It must contain no
 * backticks or `${` (it lives inside a template literal).
 *
 * Contract: scans `tf-chart-bar`/`tf-chart-line`, reads `data-labels` + `data-datasets` (JSON), and
 * draws into a canvas it creates inside the element. Colors come from the shell's CSS tokens (read
 * live via getComputedStyle) so charts stay palette-honest and re-theme for free when the frame is
 * rebuilt. Each element is isolated in try/catch — one bad chart never breaks the frame.
 */
export const A2UI_CHART_BOOTSTRAP = `(function () {
  function tok(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function renderAll() {
    if (typeof window.Chart !== "function") return;
    var palette = [tok("--primary"), tok("--muted-foreground"), tok("--foreground")];
    var grid = tok("--border");
    var tick = tok("--muted-foreground");
    var legend = tok("--foreground");

    var nodes = document.querySelectorAll("tf-chart-bar, tf-chart-line");
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      try {
        var type = el.tagName === "TF-CHART-LINE" ? "line" : "bar";
        var labels = JSON.parse(el.getAttribute("data-labels") || "[]");
        var raw = JSON.parse(el.getAttribute("data-datasets") || "[]");
        var datasets = raw.map(function (ds, j) {
          var color = palette[j % palette.length];
          var out = { label: ds.label, data: ds.data, borderColor: color };
          if (type === "line") {
            out.backgroundColor = color;
            out.pointBackgroundColor = color;
            out.fill = false;
            out.tension = 0.3;
          } else {
            out.backgroundColor = color;
          }
          return out;
        });

        var canvas = document.createElement("canvas");
        el.appendChild(canvas);
        new window.Chart(canvas, {
          type: type,
          data: { labels: labels, datasets: datasets },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            plugins: { legend: { labels: { color: legend } } },
            scales: {
              x: { grid: { color: grid }, ticks: { color: tick } },
              y: { grid: { color: grid }, ticks: { color: tick } },
            },
          },
        });
      } catch (err) {
        if (window.console && console.warn) console.warn("[a2ui] chart skipped:", err);
      }
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", renderAll);
  } else {
    renderAll();
  }
})();`;
