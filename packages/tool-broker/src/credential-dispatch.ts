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

    let authorized = false;
    try {
      authorized = await this.deps.reauthorize(effect);
    } catch {
      authorized = false;
    }
    if (!authorized) {
      throw new AdapterDispatchError("before_dispatch", "authorization_revoked", false);
    }
    if (secretRef === undefined) return adapter.dispatch(request);

    try {
      const connection = effect.intent.connection;
      const commonScope = {
        secretRef,
        toolId: effect.intent.toolId,
        targetId: effect.intent.targetRefs[0]?.id,
        runId: effect.runId,
        stateId: effect.stateId,
        purpose: effect.intent.action,
        ...(effect.intent.activeSkillName === undefined
          ? {}
          : { activeSkillName: effect.intent.activeSkillName }),
      };
      if (connection === undefined) {
        if (secondaryCredentialRef !== undefined || secondaryConnection !== undefined) {
          throw new AdapterDispatchError("before_dispatch", "credential_denied", false);
        }
        const lease = await this.deps.secrets.lease({ scope: commonScope, maxUses: 1 });
        return await lease.use((credential) => adapter.dispatch(request, credential));
      }
      const destination = effect.intent.destination;
      if (
        !connectionSecretRef(secretRef) ||
        destination === undefined ||
        connection.credentialSlot === undefined ||
        connection.credentialRevision === undefined
      ) {
        throw new AdapterDispatchError("before_dispatch", "credential_denied", false);
      }
      const primarySlot = connection.credentialSlot;
      const primaryRevision = connection.credentialRevision;
      const primaryLease: ConnectionSecretLeaseRequest = {
        scope: {
          ...commonScope,
          secretRef,
          businessId: effect.businessId,
          connectionId: connection.connectionId,
          credentialSlot: primarySlot,
          integrationId: connection.integrationId,
          integrationMajorVersion: connection.integrationMajorVersion,
          operationId: connection.operationId,
          identityMode: connection.identityMode,
          manifestDigest: connection.manifestDigest,
          configurationDigest: connection.configurationDigest,
          destination,
          credentialRevision: primaryRevision,
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
        secondaryConnection.integrationMajorVersion !== connection.integrationMajorVersion ||
        secondaryConnection.operationId !== connection.operationId ||
        secondaryConnection.identityMode !== connection.identityMode ||
        secondaryConnection.manifestDigest !== connection.manifestDigest ||
        secondaryConnection.configurationDigest !== connection.configurationDigest ||
        secondaryConnection.credentialSlot === undefined ||
        secondaryConnection.credentialRevision === undefined ||
        secondaryConnection.credentialSlot === primarySlot
      ) {
        throw new AdapterDispatchError("before_dispatch", "credential_denied", false);
      }
      const secondaryLease: ConnectionSecretLeaseRequest = {
        scope: {
          ...commonScope,
          secretRef: secondaryCredentialRef,
          businessId: effect.businessId,
          connectionId: secondaryConnection.connectionId,
          credentialSlot: secondaryConnection.credentialSlot,
          integrationId: secondaryConnection.integrationId,
          integrationMajorVersion: secondaryConnection.integrationMajorVersion,
          operationId: secondaryConnection.operationId,
          identityMode: secondaryConnection.identityMode,
          manifestDigest: secondaryConnection.manifestDigest,
          configurationDigest: secondaryConnection.configurationDigest,
          destination,
          credentialRevision: secondaryConnection.credentialRevision,
          ...(secondaryConnection.principalKind === undefined
            ? {}
            : {
                principalKind: secondaryConnection.principalKind,
                principalId: secondaryConnection.principalId,
              }),
        },
        maxUses: 1,
      };
      const secondarySlot = secondaryConnection.credentialSlot;
      const lease = await this.deps.secrets.leaseConnectionSet({
        [primarySlot]: primaryLease,
        [secondarySlot]: secondaryLease,
      });
      return await lease.use((credentials) =>
        adapter.dispatch(request, credentials[primarySlot], credentials)
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
