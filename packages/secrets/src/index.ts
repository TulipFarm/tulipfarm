export type { BackfillResult } from "./backfill";
export { backfillSecretsToDek } from "./backfill";
export type {
  SecretAuthorization,
  SecretAuthorizer,
  SecretBrokerDeps,
  SecretBrokerEvent,
  SecretBrokerEventType,
  SecretLeaseRequest,
} from "./broker";
export { SecretBroker } from "./broker";
export type { SecretEnvelope } from "./crypto";
export { DecryptError, decryptSecret, encryptSecret } from "./crypto";
export type { DekRepo, InsertWrapInput, KekLabel, WrappedDekRow } from "./dek-repo";
export { PgDekRepo } from "./dek-repo";
export { SecretsService, SecretUnavailableError } from "./encrypted-store";
export type {
  IntegrationAppField,
  IntegrationAppFieldRole,
  IntegrationAppId,
  IntegrationAppInfo,
} from "./integration-registry";
export {
  INTEGRATION_APPS,
  integrationAppById,
  integrationAppField,
  isIntegrationAppConfigured,
} from "./integration-registry";
export { assertValidSecretKey, InvalidSecretKeyError } from "./key-guard";
export type { ActiveDek } from "./key-manager";
export {
  generateDek,
  generateRecoveryKek,
  KeyManagerError,
  loadActiveDek,
  loadOrProvisionActiveDek,
  makeCanary,
  provisionRecoveryKey,
  recoverWithKey,
  rotateEnvKek,
  unwrapDek,
  verifyCanary,
  wrapDek,
} from "./key-manager";
export type { EncryptionKeys } from "./keys";
export { loadEncryptionKeys } from "./keys";
export type {
  ScopedSecretCallback,
  SecretLeaseDenialReason,
  SecretScope,
} from "./lease";
export {
  SecretLeakError,
  SecretLease,
  SecretLeaseDeniedError,
  SecretNotSerializableError,
} from "./lease";
export type { KmsPort, MasterKeyRef, WrappedKey } from "./ports";
export type { CredentialPrincipal } from "./principal-keys";
export { PRINCIPAL_MODEL_API_KEY, principalSecretKey } from "./principal-keys";
export type { InMemorySecretProvider, ResolvedSecret, SecretProvider } from "./providers";
export { inMemorySecretProvider, secretsServiceProvider } from "./providers";
export { containsSecret, REDACTED, redactError, redactSecrets } from "./redaction";
export type { LlmProviderId, LlmProviderInfo, ProviderField, ProviderFieldRole } from "./registry";
export {
  isProviderConfigured,
  LLM_PROVIDERS,
  llmProviderById,
  llmProviderForFieldKey,
  providerField,
} from "./registry";
export type {
  Queryable,
  SecretDoc,
  SecretEnvelopeFields,
  SecretMeta,
  SecretRepo,
  SecretType,
} from "./repo";
export { PgSecretRepo } from "./repo";
