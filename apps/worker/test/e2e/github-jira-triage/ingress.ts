import { normalizeGitHubIssueEvent } from "@tulipfarm/integrations";
import { type DeliveryInput, type IngressResult, REPOSITORY, WEBHOOK_SECRET } from "./fixtures";
import {
  type GitHubProvider,
  type SignedDelivery,
  signGitHubDelivery,
  verifyGitHubSignature,
} from "./providers";

/**
 * Webhook ingress for the triage tests: sign a delivery the way GitHub would, then accept it the
 * way the API does — verify the signature before parsing, before storing, and before deduping, so
 * a forged body can never reach the parser or occupy a delivery id.
 */

export interface TriageIngress {
  /** Delivery ids accepted so far, in order; a duplicate never appears twice. */
  readonly acceptedEvents: readonly string[];
  signedDelivery(input: DeliveryInput): SignedDelivery;
  ingest(delivery: SignedDelivery): Promise<IngressResult>;
}

export function createTriageIngress(github: GitHubProvider): TriageIngress {
  const seenDeliveries = new Set<string>();
  const acceptedEvents: string[] = [];

  function signedDelivery(input: DeliveryInput): SignedDelivery {
    const issue = github.issue(input.issueNumber);
    return signGitHubDelivery(WEBHOOK_SECRET, input.deliveryId, {
      action: "opened",
      repository: { full_name: REPOSITORY },
      installation: { id: 1 },
      sender: { login: issue.author, id: 900 + issue.number },
      issue: {
        number: issue.number,
        title: issue.title,
        body: issue.body,
        state: issue.state,
        html_url: `https://github.com/${REPOSITORY}/issues/${issue.number}`,
        labels: issue.labels.map((name) => ({ name })),
      },
    });
  }

  async function ingest(delivery: SignedDelivery): Promise<IngressResult> {
    // Verify before parse, store, or dedupe.
    if (!verifyGitHubSignature(WEBHOOK_SECRET, delivery)) {
      return { status: 401, code: "signature_invalid" };
    }
    const deliveryId = delivery.headers["x-github-delivery"];
    if (deliveryId === undefined) return { status: 400, code: "delivery_id_missing" };

    try {
      normalizeGitHubIssueEvent(JSON.parse(delivery.body));
    } catch {
      return { status: 400, code: "payload_rejected" };
    }

    if (seenDeliveries.has(deliveryId)) return { status: 200, outcome: "duplicate" };
    seenDeliveries.add(deliveryId);
    acceptedEvents.push(deliveryId);
    return { status: 202, outcome: "accepted" };
  }

  return { acceptedEvents, signedDelivery, ingest };
}
