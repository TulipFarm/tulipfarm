export type { BackfillResult } from "./backfill";
export { backfillSecretsToDek } from "./backfill";
export type { SecretEnvelope } from "./crypto";
export { DecryptError, decryptSecret, encryptSecret } from "./crypto";
export type { DekRepo, InsertWrapInput, KekLabel, WrappedDekRow } from "./dek-repo";
export { PgDekRepo } from "./dek-repo";
export { assertValidSecretKey, InvalidSecretKeyError } from "./key-guard";
export type { ActiveDek } from "./key-manager";
export {
  generateDek,
  generateRecoveryKek,
  KeyManagerError,
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
export { SecretsService, SecretUnavailableError } from "./service";
