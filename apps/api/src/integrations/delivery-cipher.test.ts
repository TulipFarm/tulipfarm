import { loadEncryptionKeys } from "@tulipfarm/secrets";
import { describe, expect, it } from "vitest";
import { deliveryCipher } from "./delivery-cipher";

const KEY = Buffer.alloc(32, 7).toString("base64");
const keys = () => loadEncryptionKeys({ ENCRYPTION_KEY: KEY });

describe("deliveryCipher", () => {
  it("round-trips a payload", async () => {
    const cipher = deliveryCipher(keys);
    const raw = Buffer.from('{"type":"forecast_updated"}', "utf8");

    expect(await cipher.decrypt(await cipher.encrypt(raw))).toEqual(raw);
  });

  it("round-trips bytes that are not valid UTF-8", async () => {
    // A string round-trip would replace them, and the replayed payload would no longer be the one
    // whose signature the provider computed.
    const cipher = deliveryCipher(keys);
    const raw = Buffer.from([0xff, 0xfe, 0x00, 0x41]);

    expect(await cipher.decrypt(await cipher.encrypt(raw))).toEqual(raw);
  });

  it("stores nothing recognizable from the payload", async () => {
    const cipher = deliveryCipher(keys);
    const stored = await cipher.encrypt(Buffer.from("customer@example.com", "utf8"));

    expect(stored).not.toContain("customer@example.com");
  });

  it("produces a different ciphertext each time", async () => {
    const cipher = deliveryCipher(keys);
    const raw = Buffer.from("same", "utf8");

    expect(await cipher.encrypt(raw)).not.toBe(await cipher.encrypt(raw));
  });

  it("refuses a payload encrypted under a key this deployment does not hold", async () => {
    const other = deliveryCipher(() =>
      loadEncryptionKeys({ ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64") })
    );
    const stored = await other.encrypt(Buffer.from("secret", "utf8"));

    await expect(deliveryCipher(keys).decrypt(stored)).rejects.toThrow();
  });
});
