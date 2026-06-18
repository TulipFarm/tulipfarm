import { decryptSecret, encryptSecret } from "./crypto";
import type { ActiveDek } from "./key-manager";
import type { EncryptionKeys } from "./keys";
import type { SecretRepo } from "./repo";

export interface BackfillResult {
  migrated: number;
  failed: string[];
}

// Re-encrypt every legacy (dek_id IS NULL) secret under the active DEK, tagging it with the DEK's
// id. Idempotent — only untagged rows are touched, so a re-run after a crash resumes cleanly.
// Resumable — each row is committed independently via upsert. Each row is round-trip self-checked
// (the new envelope must decrypt back to the same plaintext under the DEK) before it is persisted,
// so a bad decrypt or re-encrypt can never silently corrupt a secret. Never deletes; never logs
// plaintext.
export async function backfillSecretsToDek(
  repo: SecretRepo,
  dek: ActiveDek,
  legacyKeys: EncryptionKeys
): Promise<BackfillResult> {
  const keys = await repo.listLegacyKeys();
  const result: BackfillResult = { migrated: 0, failed: [] };

  for (const key of keys) {
    const doc = await repo.findByKey(key);
    if (!doc || doc.dekId !== null) continue; // raced or already migrated

    let plaintext: string;
    try {
      plaintext = decryptSecret(
        { encryptedValue: doc.encryptedValue, iv: doc.iv, authTag: doc.authTag },
        legacyKeys
      );
    } catch {
      result.failed.push(key);
      continue;
    }

    const envelope = encryptSecret(plaintext, dek.key);
    if (decryptSecret(envelope, { current: dek.key }) !== plaintext) {
      result.failed.push(key);
      continue;
    }

    await repo.upsert(key, { ...envelope, type: doc.type, dekId: dek.dekId });
    result.migrated += 1;
  }

  return result;
}
