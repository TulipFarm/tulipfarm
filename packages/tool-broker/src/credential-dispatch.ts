import { type SecretBroker, SecretLeakError, SecretLeaseDeniedError } from "@tulipfarm/secrets";
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

export class CredentialDispatcher {
  constructor(private readonly deps: CredentialDispatcherDeps) {}

  async dispatch(
    effect: EffectRecord,
    adapter: ToolAdapter,
    request: ToolAdapterRequest
  ): Promise<unknown> {
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
      const lease = await this.deps.secrets.lease({
        scope: {
          secretRef,
          toolId: effect.intent.toolId,
          targetId: effect.intent.targetRefs[0]?.id,
          runId: effect.runId,
          stateId: effect.stateId,
          purpose: effect.intent.action,
        },
        maxUses: 1,
      });
      return await lease.use((credential) => adapter.dispatch(request, credential));
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
