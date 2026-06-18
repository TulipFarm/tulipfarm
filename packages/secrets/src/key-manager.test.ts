import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { DekRepo, InsertWrapInput, WrappedDekRow } from "./dek-repo";
import {
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

class FakeDekRepo implements DekRepo {
  rows: WrappedDekRow[] = [];
  insertCalls = 0;

  async listActive(): Promise<WrappedDekRow[]> {
    return this.rows.filter((r) => r.retiredAt === null);
  }

  // Upsert by (dekId, kekLabel), mirroring the Pg ON CONFLICT behavior.
  async insertWrap(input: InsertWrapInput): Promise<void> {
    this.insertCalls += 1;
    const existing = this.rows.find(
      (r) => r.dekId === input.dekId && r.kekLabel === input.kekLabel && r.retiredAt === null
    );
    if (existing) {
      existing.envelope = input.envelope;
      existing.canary = input.canary ?? null;
      return;
    }
    this.rows.push({
      dekId: input.dekId,
      kekLabel: input.kekLabel,
      envelope: input.envelope,
      canary: input.canary ?? null,
      createdAt: new Date(),
      retiredAt: null,
    });
  }
}

describe("key-manager — wrap/unwrap", () => {
  it("wraps then unwraps a DEK exactly", () => {
    const dek = generateDek();
    const kek = randomBytes(32);

    const wrapped = wrapDek(dek, kek);

    expect(unwrapDek(wrapped, { current: kek }).equals(dek)).toBe(true);
  });

  it("generateDek / generateRecoveryKek return 32 distinct bytes", () => {
    expect(generateDek().length).toBe(32);
    expect(generateRecoveryKek().length).toBe(32);
    expect(generateDek().equals(generateDek())).toBe(false);
  });

  it("unwraps under the previous KEK after rotation (fallthrough)", () => {
    const dek = generateDek();
    const oldKek = randomBytes(32);
    const newKek = randomBytes(32);

    const wrapped = wrapDek(dek, oldKek);

    expect(unwrapDek(wrapped, { current: newKek, previous: oldKek }).equals(dek)).toBe(true);
  });

  it("throws KeyManagerError when no KEK authenticates", () => {
    const wrapped = wrapDek(generateDek(), randomBytes(32));

    expect(() => unwrapDek(wrapped, { current: randomBytes(32) })).toThrow(KeyManagerError);
  });
});

describe("key-manager — canary", () => {
  it("verifies a canary made under the same DEK", () => {
    const dek = generateDek();

    expect(() => verifyCanary(dek, makeCanary(dek))).not.toThrow();
  });

  it("throws on a canary from a different DEK", () => {
    const canary = makeCanary(generateDek());

    expect(() => verifyCanary(generateDek(), canary)).toThrow(KeyManagerError);
  });

  it("throws on a tampered canary authTag", () => {
    const dek = generateDek();
    const canary = { ...makeCanary(dek), authTag: randomBytes(16).toString("base64") };

    expect(() => verifyCanary(dek, canary)).toThrow(KeyManagerError);
  });
});

describe("key-manager — loadOrProvisionActiveDek", () => {
  it("auto-provisions an env wrap on first boot", async () => {
    const repo = new FakeDekRepo();
    const envKek = { current: randomBytes(32) };

    const dek = await loadOrProvisionActiveDek(repo, envKek);

    expect(repo.insertCalls).toBe(1);
    const active = await repo.listActive();
    expect(active).toHaveLength(1);
    expect(active[0].kekLabel).toBe("env");
    // the stored env wrap really wraps the returned DEK
    expect(unwrapDek(active[0].envelope, envKek).equals(dek.key)).toBe(true);
  });

  it("loads an existing DEK without re-provisioning", async () => {
    const repo = new FakeDekRepo();
    const envKek = { current: randomBytes(32) };

    const first = await loadOrProvisionActiveDek(repo, envKek);
    const second = await loadOrProvisionActiveDek(repo, envKek);

    expect(repo.insertCalls).toBe(1);
    expect(second.dekId).toBe(first.dekId);
    expect(second.key.equals(first.key)).toBe(true);
  });

  it("fail-fasts when the env wrap will not unwrap (wrong key)", async () => {
    const repo = new FakeDekRepo();
    await loadOrProvisionActiveDek(repo, { current: randomBytes(32) });

    await expect(
      loadOrProvisionActiveDek(repo, { current: randomBytes(32) })
    ).rejects.toBeInstanceOf(KeyManagerError);
  });

  it("fail-fasts when the canary is corrupt", async () => {
    const repo = new FakeDekRepo();
    const envKek = { current: randomBytes(32) };
    await loadOrProvisionActiveDek(repo, envKek);

    const row = (await repo.listActive())[0];
    const canary = row.canary;
    if (!canary) throw new Error("expected a canary on the env wrap");
    row.canary = { ...canary, authTag: randomBytes(16).toString("base64") };

    await expect(loadOrProvisionActiveDek(repo, envKek)).rejects.toBeInstanceOf(KeyManagerError);
  });

  it("fail-fasts when an env wrap has no canary at all", async () => {
    const repo = new FakeDekRepo();
    const envKek = { current: randomBytes(32) };
    const dek = generateDek();
    repo.rows.push({
      dekId: "00000000-0000-0000-0000-000000000000",
      kekLabel: "env",
      envelope: wrapDek(dek, envKek.current),
      canary: null, // an env wrap must carry a canary; absence is an integrity failure
      createdAt: new Date(),
      retiredAt: null,
    });

    await expect(loadOrProvisionActiveDek(repo, envKek)).rejects.toBeInstanceOf(KeyManagerError);
  });

  it("on a concurrent-provision conflict, re-reads and loads the winner's DEK", async () => {
    const envKek = { current: randomBytes(32) };
    const winnerDek = generateDek();
    const winnerRow: WrappedDekRow = {
      dekId: "11111111-1111-1111-1111-111111111111",
      kekLabel: "env",
      envelope: wrapDek(winnerDek, envKek.current),
      canary: makeCanary(winnerDek),
      createdAt: new Date(),
      retiredAt: null,
    };
    // No env wrap initially → provisioning path; the insert loses the race (unique violation);
    // the re-read then surfaces the winner.
    const repo: DekRepo = {
      listActive: vi
        .fn<DekRepo["listActive"]>()
        .mockResolvedValueOnce([])
        .mockResolvedValue([winnerRow]),
      insertWrap: vi
        .fn<DekRepo["insertWrap"]>()
        .mockRejectedValue(new Error("duplicate key value violates unique constraint")),
    };

    const loaded = await loadOrProvisionActiveDek(repo, envKek);

    expect(loaded.dekId).toBe(winnerRow.dekId);
    expect(loaded.key.equals(winnerDek)).toBe(true);
  });
});

describe("key-manager — rotateEnvKek", () => {
  it("re-wraps the DEK under the new env KEK; old key stops unwrapping", async () => {
    const repo = new FakeDekRepo();
    const oldKek = randomBytes(32);
    const newKek = randomBytes(32);
    const provisioned = await loadOrProvisionActiveDek(repo, { current: oldKek });

    const rotated = await rotateEnvKek(repo, { current: newKek, previous: oldKek });
    expect(rotated.key.equals(provisioned.key)).toBe(true); // same DEK, no secret re-encrypt

    // new key now loads; old key alone no longer does
    await expect(loadOrProvisionActiveDek(repo, { current: newKek })).resolves.toBeDefined();
    await expect(loadOrProvisionActiveDek(repo, { current: oldKek })).rejects.toBeInstanceOf(
      KeyManagerError
    );
  });

  it("throws when there is no active env wrap", async () => {
    const repo = new FakeDekRepo();
    await expect(rotateEnvKek(repo, { current: randomBytes(32) })).rejects.toBeInstanceOf(
      KeyManagerError
    );
  });
});

describe("key-manager — recovery", () => {
  it("recovers access via the offline recovery key after the env key is lost", async () => {
    const repo = new FakeDekRepo();
    const originalEnvKek = randomBytes(32);
    const dek = await loadOrProvisionActiveDek(repo, { current: originalEnvKek });

    // mint the offline recovery key (revealed once to the operator)
    const recoveryKek = await provisionRecoveryKey(repo, dek);
    expect(recoveryKek.length).toBe(32);

    // env key is lost; a brand-new key cannot unwrap the existing env wrap
    const freshEnvKek = randomBytes(32);
    await expect(loadOrProvisionActiveDek(repo, { current: freshEnvKek })).rejects.toBeInstanceOf(
      KeyManagerError
    );

    // break-glass: recover with the offline key and re-establish the env wrap under the fresh key
    const recovered = await recoverWithKey(repo, recoveryKek, { current: freshEnvKek });
    expect(recovered.key.equals(dek.key)).toBe(true);

    // normal boot now works under the fresh env key
    const reloaded = await loadOrProvisionActiveDek(repo, { current: freshEnvKek });
    expect(reloaded.key.equals(dek.key)).toBe(true);
  });

  it("throws when recovering without a recovery wrap present", async () => {
    const repo = new FakeDekRepo();
    await loadOrProvisionActiveDek(repo, { current: randomBytes(32) });
    await expect(
      recoverWithKey(repo, randomBytes(32), { current: randomBytes(32) })
    ).rejects.toBeInstanceOf(KeyManagerError);
  });
});
