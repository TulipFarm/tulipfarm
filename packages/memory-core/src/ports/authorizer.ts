export type AccessDecision<Value> = { kind: 'allowed'; value: Value } | { kind: 'denied'; error: Error };

export type AuthorizationChecks = Record<string, { input: unknown; value: unknown }>;

export interface Authorizer<Checks extends AuthorizationChecks> {
  decide<Check extends keyof Checks>(
    check: Check,
    input: Checks[Check]['input'],
  ): Promise<AccessDecision<Checks[Check]['value']>>;
}

export class InvalidAccessDecision extends Error {
  constructor() {
    super('Missing or invalid access decision');
  }
}

export function requireAccess<Value>(decision: AccessDecision<Value>): Value {
  if (decision?.kind === 'allowed' && Object.hasOwn(decision, 'value')) return decision.value;
  if (decision?.kind === 'denied' && decision.error instanceof Error) throw decision.error;
  throw new InvalidAccessDecision();
}

export type AccessProof = {
  aclCheckedAt: Date;
  principalCheckedAt: Date;
  expiresAt: Date;
};

export function boundedAccessProof(proof: AccessProof, maximumAgeMs: number) {
  return (
    proof.expiresAt.getTime() > Math.max(proof.aclCheckedAt.getTime(), proof.principalCheckedAt.getTime()) &&
    proof.expiresAt.getTime() <=
      Math.min(proof.aclCheckedAt.getTime(), proof.principalCheckedAt.getTime()) + maximumAgeMs
  );
}

export function currentAccessProof(proof: AccessProof, now: Date) {
  return (
    [proof.aclCheckedAt, proof.principalCheckedAt, proof.expiresAt, now].every(date =>
      Number.isFinite(date.getTime()),
    ) && !(proof.aclCheckedAt > now || proof.principalCheckedAt > now || proof.expiresAt <= now)
  );
}
