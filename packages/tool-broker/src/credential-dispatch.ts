import {
  type ConnectionSecretLeaseRequest,
  type SecretBroker,
  SecretLeakError,
  SecretLeaseDeniedError,
} from "@tulipfarm/secrets";
import {
  AdapterDispatchError,
  type EffectRecord,
  type ToolAdapter,
  type ToolAdapterRequest,
} from "./effects";

export interface CredentialDispatcherDeps {
  readonly secrets: SecretBroker;
  readonly reauthorize: (effect: EffectRecord) => Promise<boolean> | boolean;
}

function connectionSecretRef(value: string): value is `secret://${string}` {
  return value.startsWith("secret://") && value.length > "secret://".length;
}

export class CredentialDispatcher {
  constructor(private readonly deps: CredentialDispatcherDeps) {}

  async dispatch(
    effect: EffectRecord,
    adapter: ToolAdapter,
    request: ToolAdapterRequest
  ): Promise<unknown> {
    const { secondaryCredentialRef, secondaryConnection } = effect.intent;
    const secretRef = effect.intent.credentialRef;
    if (secretRef === undefined) return adapter.dispatch(request);

    let authorized = false;
    try {
      authorized = await this.deps.reauthorize(effect);
    } catch {
      authorized = false;
    }
    if (!authorized) {
      throw new AdapterDispatchError("before_dispatch", "authorization_revoked", false);
    }

    try {
      const connection = effect.intent.connection;
      const commonScope = {
        secretRef,
        toolId: effect.intent.toolId,
        targetId: effect.intent.targetRefs[0]?.id,
        runId: effect.runId,
        stateId: effect.stateId,
        purpose: effect.intent.action,
      };
      if (connection === undefined) {
        if (secondaryCredentialRef !== undefined || secondaryConnection !== undefined) {
          throw new AdapterDispatchError("before_dispatch", "credential_denied", false);
        }
        const lease = await this.deps.secrets.lease({ scope: commonScope, maxUses: 1 });
        return await lease.use((credential) => adapter.dispatch(request, credential));
      }
      const destination = effect.intent.destination;
      if (!connectionSecretRef(secretRef) || destination === undefined) {
        throw new AdapterDispatchError("before_dispatch", "credential_denied", false);
      }
      const primaryLease: ConnectionSecretLeaseRequest = {
        scope: {
          ...commonScope,
          secretRef,
          connectionId: connection.connectionId,
          credentialSlot: connection.credentialSlot,
          integrationId: connection.integrationId,
          destination,
          ...(connection.principalKind === undefined
            ? {}
            : {
                principalKind: connection.principalKind,
                principalId: connection.principalId,
              }),
        },
        maxUses: 1,
      };
      if (secondaryCredentialRef === undefined && secondaryConnection === undefined) {
        const lease = await this.deps.secrets.leaseConnection(primaryLease);
        return await lease.use((credential) => adapter.dispatch(request, credential));
      }
      if (
        secondaryCredentialRef === undefined ||
        secondaryConnection === undefined ||
        !connectionSecretRef(secondaryCredentialRef) ||
        secondaryConnection.connectionId !== connection.connectionId ||
        secondaryConnection.integrationId !== connection.integrationId ||
        secondaryConnection.credentialSlot === connection.credentialSlot
      ) {
        throw new AdapterDispatchError("before_dispatch", "credential_denied", false);
      }
      const secondaryLease: ConnectionSecretLeaseRequest = {
        scope: {
          ...commonScope,
          secretRef: secondaryCredentialRef,
          connectionId: secondaryConnection.connectionId,
          credentialSlot: secondaryConnection.credentialSlot,
          integrationId: secondaryConnection.integrationId,
          destination,
          ...(secondaryConnection.principalKind === undefined
            ? {}
            : {
                principalKind: secondaryConnection.principalKind,
                principalId: secondaryConnection.principalId,
              }),
        },
        maxUses: 1,
      };
      const lease = await this.deps.secrets.leaseConnectionSet({
        [connection.credentialSlot]: primaryLease,
        [secondaryConnection.credentialSlot]: secondaryLease,
      });
      return await lease.use((credentials) =>
        adapter.dispatch(request, credentials[connection.credentialSlot], credentials)
      );
    } catch (error) {
      if (error instanceof AdapterDispatchError) {
        throw error;
      }
      if (error instanceof SecretLeakError) {
        throw new AdapterDispatchError("after_dispatch", "credential_output_blocked", false);
      }
      if (error instanceof SecretLeaseDeniedError) {
        throw new AdapterDispatchError("before_dispatch", "credential_denied", false);
      }
      throw new AdapterDispatchError("after_dispatch", "credential_dispatch_failed", false);
    }
  }
}
