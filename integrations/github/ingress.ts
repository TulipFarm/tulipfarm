// GitHub ingress classifier for TulipFarm. Runs inside the host's isolated-vm sandbox as a
// pure function — no network, no filesystem, no timers. GitHub is events-only ingress: every
// verified webhook delivery becomes an integration.event that routines can trigger on; there
// is no chat surface. The event name lives in the X-GitHub-Event header (declared via the
// manifest's context_headers), and the body's `action` narrows it (issues.opened,
// pull_request.closed, …). Authored as an object-literal expression (same contract as routine
// hooks.ts).
({
  classify(ctx) {
    const headers = ctx.headers || {};
    const eventName = String(headers["x-github-event"] == null ? "" : headers["x-github-event"]);
    if (!eventName) return { kind: "ignore", reason: "missing x-github-event header" };
    // GitHub's webhook-creation ping — the 200 ack is all it wants.
    if (eventName === "ping") return { kind: "ignore", reason: "ping" };

    const body = ctx.body || {};
    const action = typeof body.action === "string" && body.action ? "." + body.action : "";
    return { kind: "event", eventType: eventName + action, payload: body };
  },
});
