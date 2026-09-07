/**
 * The Events profile, proved against a package on disk rather than a fixture.
 *
 * `oim-reference-compile.test.ts` proves the shipped packages become callable Tools. This proves
 * the other direction: that a delivery shaped like the provider's own documented payload survives
 * verification, acceptance, typing and deduplication using only what the manifest declares.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseOimManifest } from "@tulipfarm/schema";
import { beforeAll, describe, expect, it } from "vitest";
import {
  decideAcceptance,
  deduplicationKey,
  normalizeHeaders,
  parseDeliveryBody,
  safeHeadersFor,
  selectEventType,
} from "./delivery";
import { verifyDelivery } from "./verify";

const ROOT = join(__dirname, "..", "..", "..", "..", "integrations");
const SECRET = "a-long-random-webhook-secret-token";

/** Trimmed from the payload GitLab documents for an Issue Hook. */
const ISSUE_BODY = JSON.stringify({
  object_kind: "issue",
  event_type: "issue",
  user: { id: 1, name: "Muskan Vijayvargiya", username: "muskan" },
  project: { id: 14, path_with_namespace: "acme/web", web_url: "https://gitlab.com/acme/web" },
  object_attributes: {
    iid: 23,
    title: "New API for repository manipulation",
    description: "Create new API for manipulations with repository",
    state: "opened",
    action: "open",
    url: "https://gitlab.com/acme/web/-/issues/23",
  },
});

function delivery(body: string, headers: Record<string, string>) {
  const rawBody = new TextEncoder().encode(body);
  return { request: { headers, rawBody }, rawBody };
}

const ISSUE_HEADERS = {
  "content-type": "application/json",
  "X-Gitlab-Event": "Issue Hook",
  "X-Gitlab-Event-UUID": "13792a34-cac6-4b6b-b2b3-c1b6b0a0b0d2",
  "X-Gitlab-Token": SECRET,
};

let events: NonNullable<Awaited<ReturnType<typeof loadEvents>>>;

async function loadEvents() {
  const manifest = parseOimManifest(await readFile(join(ROOT, "gitlab", "oim.yml"), "utf8"));
  return manifest.events;
}

describe("gitlab ingress", () => {
  beforeAll(async () => {
    const loaded = await loadEvents();
    if (loaded === undefined) throw new Error("gitlab package declares no events");
    events = loaded;
  });

  it("accepts a documented Issue Hook and types it from the body", () => {
    const { request, rawBody } = delivery(ISSUE_BODY, ISSUE_HEADERS);

    expect(verifyDelivery(events.verification, request, SECRET)).toEqual({ ok: true });

    const parsed = { body: parseDeliveryBody(rawBody), headers: normalizeHeaders(request.headers) };
    expect(decideAcceptance(events, parsed)).toEqual({
      kind: "accept",
      eventType: selectEventType(events, parsed),
    });
    expect(selectEventType(events, parsed)?.type).toBe("issue");
    expect(deduplicationKey(events, parsed, rawBody)).toEqual({
      kind: "declared",
      value: ISSUE_HEADERS["X-Gitlab-Event-UUID"],
    });
  });

  it("refuses a delivery carrying the wrong secret token", () => {
    const { request } = delivery(ISSUE_BODY, { ...ISSUE_HEADERS, "X-Gitlab-Token": "guessed" });

    expect(verifyDelivery(events.verification, request, SECRET).ok).toBe(false);
  });

  it("discards an event kind the package never declared", () => {
    const body = JSON.stringify({
      object_kind: "pipeline",
      object_attributes: { status: "failed" },
    });
    const { request, rawBody } = delivery(body, { ...ISSUE_HEADERS });
    const parsed = { body: parseDeliveryBody(rawBody), headers: normalizeHeaders(request.headers) };

    expect(decideAcceptance(events, parsed)).toEqual({
      kind: "discard",
      reason: "unknown_event_type",
    });
  });

  it("never exposes the secret-bearing header to a hook", () => {
    const { request, rawBody } = delivery(ISSUE_BODY, ISSUE_HEADERS);
    const parsed = { body: parseDeliveryBody(rawBody), headers: normalizeHeaders(request.headers) };

    const safe = safeHeadersFor(events, selectEventType(events, parsed), parsed.headers);
    expect(safe).toEqual({
      "x-gitlab-event": "Issue Hook",
      "x-gitlab-event-uuid": ISSUE_HEADERS["X-Gitlab-Event-UUID"],
    });
    expect(Object.keys(safe)).not.toContain("x-gitlab-token");
  });
});
