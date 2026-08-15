import type { AuthMethod } from "../auth/session-store";

/**
 * Step-up authentication (SPEC §12: "passkeys/MFA where the identity provider supports them"). With
 * no verifier registered the step-up route denies — an unimplemented factor is never treated as a
 * satisfied one.
 */

export interface MfaChallenge {
  readonly userId: string;
  readonly method: AuthMethod;
  /** Opaque, method-specific proof (TOTP code, passkey assertion). Never logged or persisted. */
  readonly proof: unknown;
}

export interface MfaVerifier {
  readonly method: AuthMethod;
  verify(challenge: MfaChallenge): Promise<boolean>;
}

export class MfaVerifierRegistry {
  private readonly verifiers = new Map<AuthMethod, MfaVerifier>();

  constructor(verifiers: readonly MfaVerifier[] = []) {
    for (const verifier of verifiers) {
      this.verifiers.set(verifier.method, verifier);
    }
  }

  register(verifier: MfaVerifier): void {
    this.verifiers.set(verifier.method, verifier);
  }

  get(method: AuthMethod): MfaVerifier | undefined {
    return this.verifiers.get(method);
  }

  supportedMethods(): AuthMethod[] {
    return [...this.verifiers.keys()].sort();
  }
}

export interface StepUpPolicy {
  readonly methods: readonly AuthMethod[];
  /** How recently the factor must have been proven, in seconds. */
  readonly maxAgeSeconds: number;
}

export type StepUpDenialReason = "unauthenticated" | "step_up_required" | "step_up_stale";

export interface StepUpEvaluation {
  readonly satisfied: boolean;
  readonly reason?: StepUpDenialReason;
}

/**
 * Pure policy check against a request principal's recorded authentication evidence. A principal
 * without a session (API token or API client) can never satisfy step-up: it has no interactive
 * factor to re-prove.
 */
export function evaluateStepUp(
  principal:
    | {
        readonly authMethods: readonly AuthMethod[];
        readonly mfaVerifiedAt?: Date;
      }
    | undefined,
  policy: StepUpPolicy,
  now: Date = new Date()
): StepUpEvaluation {
  if (!principal) return { satisfied: false, reason: "unauthenticated" };
  const satisfiedMethod = policy.methods.some((method) => principal.authMethods.includes(method));
  if (!satisfiedMethod || !principal.mfaVerifiedAt) {
    return { satisfied: false, reason: "step_up_required" };
  }
  const ageSeconds = (now.getTime() - principal.mfaVerifiedAt.getTime()) / 1000;
  if (ageSeconds > policy.maxAgeSeconds) {
    return { satisfied: false, reason: "step_up_stale" };
  }
  return { satisfied: true };
}
