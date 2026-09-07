export interface ConnectionLeaseBroker {
  revokeConnection(connectionId: string): void | Promise<void>;
}

export type TrackConnectionBroker = (broker: ConnectionLeaseBroker) => () => void;

interface BrokerRegistration {
  readonly reference: WeakRef<ConnectionLeaseBroker>;
}

/**
 * Tracks in-process Connection lease brokers without extending their lifetime.
 *
 * One registry belongs to one deployment. Database-backed live authorization remains the
 * cross-process guard; this registry closes already-issued leases in the current API process.
 */
export class ConnectionLeaseRegistry {
  private readonly registrations = new Set<BrokerRegistration>();
  private readonly finalizer = new FinalizationRegistry<BrokerRegistration>((registration) => {
    this.registrations.delete(registration);
  });

  constructor(private readonly businessId: string) {}

  readonly track: TrackConnectionBroker = (broker) => {
    const registration = { reference: new WeakRef(broker) };
    const unregisterToken = {};
    this.registrations.add(registration);
    this.finalizer.register(broker, registration, unregisterToken);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.registrations.delete(registration);
      this.finalizer.unregister(unregisterToken);
    };
  };

  readonly revokeConnectionLeases = async (input: {
    businessId: string;
    connectionId: string;
  }): Promise<void> => {
    if (input.businessId !== this.businessId) {
      throw new Error("Connection lease registry belongs to another deployment");
    }
    const brokers: ConnectionLeaseBroker[] = [];
    for (const registration of this.registrations) {
      const broker = registration.reference.deref();
      if (broker === undefined) {
        this.registrations.delete(registration);
      } else {
        brokers.push(broker);
      }
    }
    const results = await Promise.allSettled(
      brokers.map((broker) =>
        Promise.resolve().then(() => broker.revokeConnection(input.connectionId))
      )
    );
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : []
    );
    if (failures.length > 0) {
      throw new AggregateError(failures, "Connection lease revocation did not complete");
    }
  };
}
