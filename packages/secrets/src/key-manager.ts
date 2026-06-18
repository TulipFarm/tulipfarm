import { randomBytes, randomUUID } from "node:crypto";
import { DecryptError, decryptSecret, encryptSecret, type SecretEnvelope } from "./crypto";
import type { DekRepo, WrappedDekRow } from "./dek-repo";
import type { EncryptionKeys } from "./keys";

export class KeyManagerError extends Error {}

const DEK_LENGTH_BYTES = 32;
// Fixed, well-known, non-secret. Encrypted under the DEK so boot can prove the DEK still
// authenticates its own data at rest — distinct from "a KEK unwrapped the DEK".
const CANARY_PLAINTEXT = "tulipfarm.dek.canary.v1";

export interface ActiveDek {
  dekId: string;
  key: Buffer; // 32-byte plaintext DEK — lives only in memory, never logged or persisted
}

export function generateDek(): Buffer {
  return randomBytes(DEK_LENGTH_BYTES);
}

export function generateRecoveryKek(): Buffer {
  return randomBytes(DEK_LENGTH_BYTES);
}

// Wrap a DEK under a KEK: the DEK (base64) is "the plaintext" for the existing GCM codec.
export function wrapDek(dek: Buffer, kek: Buffer): SecretEnvelope {
  return encryptSecret(dek.toString("base64"), kek);
}

// Unwrap with current→previous KEK fallthrough (reuses decryptSecret's dual-key logic, so an
// in-flight KEK rotation still unwraps). A DecryptError — no KEK authenticated — is surfaced as
// KeyManagerError; any other error propagates unchanged.
export function unwrapDek(envelope: SecretEnvelope, kek: EncryptionKeys): Buffer {
  try {
    return Buffer.from(decryptSecret(envelope, kek), "base64");
  } catch (err) {
    if (err instanceof DecryptError) {
      throw new KeyManagerError("DEK unwrap failed: no KEK authenticated");
    }
    throw err;
  }
}

export function makeCanary(dek: Buffer): SecretEnvelope {
  return encryptSecret(CANARY_PLAINTEXT, dek);
}

// Fail-fast: the DEK must decrypt + GCM-authenticate the stored canary and recover its plaintext.
export function verifyCanary(dek: Buffer, canary: SecretEnvelope): void {
  let plaintext: string;
  try {
    plaintext = decryptSecret(canary, { current: dek });
  } catch {
    throw new KeyManagerError("DEK canary failed to authenticate at rest");
  }
  if (plaintext !== CANARY_PLAINTEXT) {
    throw new KeyManagerError("DEK canary plaintext mismatch");
  }
}

// Load an existing env wrap: unwrap the DEK and verify the canary. An env wrap MUST carry a canary
// (provisioning, rotation, and recovery all write one) — a missing canary is itself an integrity
// failure, so we fail-fast rather than silently skip the check.
function loadFromEnvWrap(envWrap: WrappedDekRow, envKek: EncryptionKeys): ActiveDek {
  const key = unwrapDek(envWrap.envelope, envKek);
  if (!envWrap.canary) {
    throw new KeyManagerError("env wrap is missing its canary — cannot verify DEK integrity");
  }
  verifyCanary(key, envWrap.canary);
  return { dekId: envWrap.dekId, key };
}

// Boot loader. Returns the active DEK, auto-provisioning one (wrapped under the env KEK, with a
// canary) on first boot when none exists — preserving zero-setup. Throws KeyManagerError if an
// existing env wrap won't unwrap or its canary won't authenticate: the fail-fast boot signal.
export async function loadOrProvisionActiveDek(
  repo: DekRepo,
  envKek: EncryptionKeys
): Promise<ActiveDek> {
  const envWrap = (await repo.listActive()).find((w) => w.kekLabel === "env");
  if (envWrap) {
    return loadFromEnvWrap(envWrap, envKek);
  }

  // First boot: provision a DEK wrapped under the env KEK. Two concurrent boots can both reach
  // here; the `(kek_label) WHERE retired_at IS NULL` partial unique index lets only one env wrap
  // win. The loser's insert throws — it re-reads and loads the winner's DEK, so both boots
  // converge on the same DEK and no secrets are orphaned.
  const key = generateDek();
  const dekId = randomUUID();
  try {
    await repo.insertWrap({
      dekId,
      kekLabel: "env",
      envelope: wrapDek(key, envKek.current),
      canary: makeCanary(key),
    });
    return { dekId, key };
  } catch {
    const winner = (await repo.listActive()).find((w) => w.kekLabel === "env");
    if (!winner) {
      throw new KeyManagerError("DEK provisioning failed and no active env wrap exists");
    }
    return loadFromEnvWrap(winner, envKek);
  }
}

// Cheap KEK rotation: re-wrap the active DEK under the current env KEK. The operator sets the new
// key as ENCRYPTION_KEY and the old as ENCRYPTION_KEY_PREVIOUS; this unwraps under the previous
// key and re-wraps under the current one. Secrets are never touched.
export async function rotateEnvKek(repo: DekRepo, envKek: EncryptionKeys): Promise<ActiveDek> {
  const envWrap = (await repo.listActive()).find((w) => w.kekLabel === "env");
  if (!envWrap) {
    throw new KeyManagerError("no active env wrap to rotate");
  }
  const key = unwrapDek(envWrap.envelope, envKek);
  await repo.insertWrap({
    dekId: envWrap.dekId,
    kekLabel: "env",
    envelope: wrapDek(key, envKek.current),
    canary: makeCanary(key),
  });
  return { dekId: envWrap.dekId, key };
}

// Mint (or re-mint) the offline recovery wrap for the active DEK and return the recovery KEK to
// reveal exactly once. The recovery KEK is never persisted — only the DEK wrapped under it is.
export async function provisionRecoveryKey(repo: DekRepo, dek: ActiveDek): Promise<Buffer> {
  const recoveryKek = generateRecoveryKek();
  await repo.insertWrap({
    dekId: dek.dekId,
    kekLabel: "recovery",
    envelope: wrapDek(dek.key, recoveryKek),
    canary: null,
  });
  return recoveryKek;
}

// Break-glass: the env KEK is lost. Unwrap the DEK from the recovery wrap using the offline
// recovery KEK, then re-establish the env wrap under a fresh env KEK so normal operation resumes.
export async function recoverWithKey(
  repo: DekRepo,
  recoveryKek: Buffer,
  freshEnvKek: EncryptionKeys
): Promise<ActiveDek> {
  const recoveryWrap = (await repo.listActive()).find((w) => w.kekLabel === "recovery");
  if (!recoveryWrap) {
    throw new KeyManagerError("no recovery wrap present — cannot recover");
  }
  const key = unwrapDek(recoveryWrap.envelope, { current: recoveryKek });
  await repo.insertWrap({
    dekId: recoveryWrap.dekId,
    kekLabel: "env",
    envelope: wrapDek(key, freshEnvKek.current),
    canary: makeCanary(key),
  });
  return { dekId: recoveryWrap.dekId, key };
}
