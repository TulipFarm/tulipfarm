import { type ScriptContext, ScriptedAdapter } from "./scripted";

export type IntegrationResponseFactory<Request, Response> = (
  context: ScriptContext<Request>
) => Response | Promise<Response>;

export class FakeIntegrationAdapter<IngressRequest, Event, DeliveryRequest, Receipt> {
  private readonly ingress = new ScriptedAdapter<IngressRequest, Event>("integration ingress");
  private readonly delivery = new ScriptedAdapter<DeliveryRequest, Receipt>("integration delivery");

  get ingressCalls(): readonly IngressRequest[] {
    return this.ingress.calls;
  }

  get deliveryCalls(): readonly DeliveryRequest[] {
    return this.delivery.calls;
  }

  respondToIngressWith(response: Event): void {
    this.ingress.respondWith(response);
  }

  respondToIngressUsing(factory: IntegrationResponseFactory<IngressRequest, Event>): void {
    this.ingress.respondUsing(factory);
  }

  failIngressWith(error: Error): void {
    this.ingress.failWith(error);
  }

  respondToDeliveryWith(response: Receipt): void {
    this.delivery.respondWith(response);
  }

  respondToDeliveryUsing(factory: IntegrationResponseFactory<DeliveryRequest, Receipt>): void {
    this.delivery.respondUsing(factory);
  }

  failDeliveryWith(error: Error): void {
    this.delivery.failWith(error);
  }

  ingest(request: IngressRequest): Promise<Event> {
    return this.ingress.invoke(request);
  }

  deliver(request: DeliveryRequest): Promise<Receipt> {
    return this.delivery.invoke(request);
  }

  assertDrained(): void {
    this.ingress.assertDrained();
    this.delivery.assertDrained();
  }
}
