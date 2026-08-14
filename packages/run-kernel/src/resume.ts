import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { assertRunTransition } from "./model";

/** Entropy of a resume token. 256 bits keeps the token unguessable under offline enumeration. */
const RESUME_TOKEN_BYTES = 32;

export interface MintedResumeToken {
  /** Returned to the caller exactly once; never persisted, logged, or placed in an Artifact. */
  readonly token: string;
  /** SHA-256 of the token — the only form that reaches storage. */
  readonly tokenHash: string;
}

/** Creates an unguessable one-use resume token and the digest stored beside the wait. */
export function mintResumeToken(): MintedResumeToken {
  const token = randomBytes(RESUME_TOKEN_BYTES).toString("base64url");
  return { token, tokenHash: hashResumeToken(token) };
}

/** Digest used to look a wait up by presented token; storage never sees the token itself. */
export function hashResumeToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Constant-time digest comparison for callers that hold two hashes. */
export function resumeTokenHashEquals(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  if (leftBytes.length !== rightBytes.length) return false;
  return timingSafeEqual(leftBytes, rightBytes);
}

export interface RunResumeStore {
  requeueWaitingRun(businessId: string, runId: string): Promise<boolean>;
}

/** Resolved waits requeue under canonical transition and status guards, exactly once. */
export class RunResumeGateway {
  constructor(private readonly store: RunResumeStore) {}

  async resume(businessId: string, runId: string): Promise<boolean> {
    assertRunTransition("waiting", "queued");
    return this.store.requeueWaitingRun(businessId, runId);
  }
}
