/**
 * In-iframe force-graph bootstrap, injected into the srcdoc as a nonce'd <script>. Injected only when
 * the sanitized HTML contains a `tf-force-graph` element (see srcdoc.ts), so graph-free frames stay
 * lean. Renders agent-composed ForceGraph specs the same way the chart bootstrap renders charts.
 *
 * Authored as an audited STRING (not a value-imported module) so it stays self-contained inside the
 * sandboxed frame and survives bundling unchanged — same contract as chart-bootstrap.ts. It must
 * contain no backticks or `${` (it lives inside a template literal).
 *
 * Contract: scans `tf-force-graph`, reads `data-nodes` (`[{id,title,okfType}]`) + `data-edges`
 * (`[{sourceId,targetId,broken}]`) as JSON, runs a small headless force simulation (charge + link
 * springs, fixed iterations — no animation loop), and draws an SVG: nodes are circles coloured by
 * okfType from CSS tokens, edges are lines (dashed when broken). No external deps (CSP-safe). Each
 * element is isolated in try/catch — one bad graph never breaks the frame.
 */
export const A2UI_FORCE_GRAPH_BOOTSTRAP = `(function () {
  var SVG = "http://www.w3.org/2000/svg";
  var W = 640, H = 360, R = 7;

  function tok(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function el(name, attrs) {
    var node = document.createElementNS(SVG, name);
    for (var k in attrs) if (attrs.hasOwnProperty(k)) node.setAttribute(k, attrs[k]);
    return node;
  }

  function colorFor(types) {
    var palette = [tok("--primary"), tok("--muted-foreground"), tok("--foreground")];
    var map = {};
    for (var i = 0; i < types.length; i++) map[types[i]] = palette[i % palette.length];
    return map;
  }

  function simulate(nodes, links) {
    // Seed nodes on a circle (deterministic), then relax with charge repulsion + link springs.
    var n = nodes.length;
    for (var i = 0; i < n; i++) {
      var a = (2 * Math.PI * i) / Math.max(1, n);
      nodes[i].x = W / 2 + Math.cos(a) * 120;
      nodes[i].y = H / 2 + Math.sin(a) * 120;
    }
    var iterations = Math.min(300, 120 + n * 4);
    for (var t = 0; t < iterations; t++) {
      for (var i = 0; i < n; i++) {
        var dx = 0, dy = 0;
        for (var j = 0; j < n; j++) {
          if (i === j) continue;
          var ox = nodes[i].x - nodes[j].x;
          var oy = nodes[i].y - nodes[j].y;
          var d2 = ox * ox + oy * oy || 0.01;
          var f = 2200 / d2;
          dx += (ox / Math.sqrt(d2)) * f;
          dy += (oy / Math.sqrt(d2)) * f;
        }
        nodes[i].vx = (nodes[i].vx || 0) * 0.5 + dx;
        nodes[i].vy = (nodes[i].vy || 0) * 0.5 + dy;
      }
      for (var k = 0; k < links.length; k++) {
        var s = links[k].s, g = links[k].t;
        if (!s || !g) continue;
        var lx = g.x - s.x, ly = g.y - s.y;
        var dist = Math.sqrt(lx * lx + ly * ly) || 0.01;
        var pull = (dist - 90) * 0.05;
        var ux = (lx / dist) * pull, uy = (ly / dist) * pull;
        s.vx = (s.vx || 0) + ux; s.vy = (s.vy || 0) + uy;
        g.vx = (g.vx || 0) - ux; g.vy = (g.vy || 0) - uy;
      }
      // Pull toward center + integrate, clamped into the viewport.
      for (var i = 0; i < n; i++) {
        nodes[i].vx = (nodes[i].vx || 0) + (W / 2 - nodes[i].x) * 0.01;
        nodes[i].vy = (nodes[i].vy || 0) + (H / 2 - nodes[i].y) * 0.01;
        nodes[i].x = Math.max(R + 2, Math.min(W - R - 2, nodes[i].x + nodes[i].vx * 0.1));
        nodes[i].y = Math.max(R + 2, Math.min(H - R - 2, nodes[i].y + nodes[i].vy * 0.1));
      }
    }
  }

  function renderOne(host) {
    var rawNodes = JSON.parse(host.getAttribute("data-nodes") || "[]");
    var rawEdges = JSON.parse(host.getAttribute("data-edges") || "[]");
    var nodes = [];
    var byId = {};
    var typeSet = [];
    for (var i = 0; i < rawNodes.length; i++) {
      var rn = rawNodes[i];
      var node = { id: String(rn.id), title: rn.title || String(rn.id), okfType: rn.okfType || "-" };
      nodes.push(node);
      byId[node.id] = node;
      if (typeSet.indexOf(node.okfType) === -1) typeSet.push(node.okfType);
    }
    var colors = colorFor(typeSet);
    var links = [];
    for (var k = 0; k < rawEdges.length; k++) {
      var re = rawEdges[k];
      var s = byId[String(re.sourceId)];
      var g = re.targetId != null ? byId[String(re.targetId)] : null;
      if (s && g) links.push({ s: s, t: g, broken: !!re.broken });
    }
    simulate(nodes, links);

    var svg = el("svg", { viewBox: "0 0 " + W + " " + H, preserveAspectRatio: "xMidYMid meet" });
    var border = tok("--border");
    for (var k = 0; k < links.length; k++) {
      var line = el("line", {
        x1: links[k].s.x, y1: links[k].s.y, x2: links[k].t.x, y2: links[k].t.y,
        stroke: border, "stroke-width": "1",
      });
      if (links[k].broken) line.setAttribute("stroke-dasharray", "4 3");
      svg.appendChild(line);
    }
    for (var i = 0; i < nodes.length; i++) {
      var nd = nodes[i];
      var c = el("circle", {
        cx: nd.x, cy: nd.y, r: String(R),
        fill: colors[nd.okfType] || tok("--muted-foreground"),
        stroke: tok("--background"), "stroke-width": "1.5",
      });
      var title = el("title", {});
      title.textContent = nd.title + (nd.okfType !== "-" ? " - " + nd.okfType : "");
      c.appendChild(title);
      svg.appendChild(c);
      var label = el("text", {
        x: nd.x + R + 3, y: nd.y + 3, fill: tok("--foreground"),
        "font-size": "10", "font-family": "ui-monospace, monospace",
      });
      label.textContent = nd.title;
      svg.appendChild(label);
    }
    host.appendChild(svg);
  }

  function renderAll() {
    var hosts = document.querySelectorAll("tf-force-graph");
    for (var i = 0; i < hosts.length; i++) {
      try { renderOne(hosts[i]); }
      catch (err) { if (window.console && console.warn) console.warn("[a2ui] force-graph skipped:", err); }
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", renderAll);
  } else {
    renderAll();
  }
})();`;
