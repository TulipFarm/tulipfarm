import type { Finding } from "./finding";

/**
 * Reserved Task dedupe-key namespace. Enforced, not conventional — no other producer writes it.
 *
 * The same rule the Curator's namespace exists for: a key derived from a finding's identity is
 * what stops a dismissed escalation from being resurrected by rewording it, and an Agent able to
 * write into this namespace could resurrect one, or squat the key of a defect not yet found.
 */
export const DOCTOR_DEDUPE_PREFIX = "doctor:";

/**
 * Derived from the finding's subject rather than its fingerprint.
 *
 * A fingerprint carries the artifact digest, so it changes on every republish — keying Tasks by it
 * would open a fresh Task each time the file is touched while the defect survives. The subject is
 * what a person recognises and what they act on.
 */
export function doctorDedupeKey(finding: Finding): string {
  return `${DOCTOR_DEDUPE_PREFIX}${finding.code}:${finding.subject.kind}:${finding.subject.id}`;
}

export function isDoctorDedupeKey(key: string): boolean {
  return key.startsWith(DOCTOR_DEDUPE_PREFIX);
}
