import { describe, expect, it } from "vitest";
import { FakeIntegrationAdapter } from "./integration-adapter";

type Ingress = { deliveryId: string; payload: unknown };
type Event = { eventId: string; type: string };
type Delivery = { destination: string; body: string };
type Receipt = { externalId: string };

describe("FakeIntegrationAdapter", () => {
  it("scripts ingress normalization and outbound delivery independently", async () => {
    const integration = new FakeIntegrationAdapter<Ingress, Event, Delivery, Receipt>();
    integration.respondToIngressUsing(({ request }) => ({
      eventId: `event-${request.deliveryId}`,
      type: "issue.created",
    }));
    integration.respondToDeliveryUsing(({ request }) => ({
      externalId: `message-${request.destination}`,
    }));

    await expect(
      integration.ingest({ deliveryId: "delivery-1", payload: { issue: 1 } })
    ).resolves.toEqual({ eventId: "event-delivery-1", type: "issue.created" });
    await expect(
      integration.deliver({ destination: "channel-1", body: "Acknowledged" })
    ).resolves.toEqual({ externalId: "message-channel-1" });
    expect(integration.ingressCalls).toEqual([{ deliveryId: "delivery-1", payload: { issue: 1 } }]);
    expect(integration.deliveryCalls).toEqual([{ destination: "channel-1", body: "Acknowledged" }]);
    expect(() => integration.assertDrained()).not.toThrow();
  });

  it("keeps ingress and delivery failures explicit and isolated", async () => {
    const integration = new FakeIntegrationAdapter<Ingress, Event, Delivery, Receipt>();
    integration.failIngressWith(new Error("invalid signature"));
    integration.failDeliveryWith(new Error("rate limited"));

    await expect(integration.ingest({ deliveryId: "bad", payload: null })).rejects.toThrow(
      "invalid signature"
    );
    await expect(integration.deliver({ destination: "channel-1", body: "hello" })).rejects.toThrow(
      "rate limited"
    );
  });
});
