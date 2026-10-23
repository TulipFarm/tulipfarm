import type { VariantState } from './contracts.ts';

/** `no-receipt` and `receipt` gate a transition on whether the variant has an attempted mutating step. */
export type TransitionCondition = 'no-receipt' | 'receipt';
export type VariantTransition = {
  readonly from: VariantState;
  readonly to: VariantState;
  readonly when: string;
  readonly requires?: TransitionCondition;
};

export const finalVariantStates: ReadonlySet<VariantState> = new Set([
  'published',
  'failed',
  'not-published',
  'superseded',
  'cancelled',
]);

/** TECH: a new revision copies only these states, and only without an attempted step. */
const supersedable = ['draft', 'awaiting-approval', 'scheduled', 'blocked'] as const;
const nonFinal = [
  'draft',
  'awaiting-approval',
  'scheduled',
  'sending',
  'processing',
  'blocked',
  'outcome-unknown',
] as const;

export const variantTransitions: readonly VariantTransition[] = [
  { from: 'draft', to: 'awaiting-approval', when: 'Every variant validates' },
  { from: 'awaiting-approval', to: 'scheduled', when: 'The revision is approved; dueAt is set' },
  { from: 'awaiting-approval', to: 'cancelled', when: 'The revision is rejected or expires' },
  {
    from: 'scheduled',
    to: 'sending',
    when: 'dueAt has passed, every check passes and the first mutating step is claimed',
  },
  { from: 'scheduled', to: 'blocked', when: 'A check fails at claim time' },
  { from: 'sending', to: 'processing', when: 'The step succeeded and an await step or another mutating step follows' },
  {
    from: 'processing',
    to: 'sending',
    when: 'The awaited state is ready and the next mutating step is claimed after the same checks',
  },
  { from: 'processing', to: 'blocked', when: 'A check fails before the next mutating step' },
  { from: 'sending', to: 'published', when: 'The final step confirmed a post' },
  { from: 'processing', to: 'published', when: 'The awaited state confirmed a post' },
  { from: 'sending', to: 'failed', when: 'The platform confirmed a rejection' },
  { from: 'processing', to: 'failed', when: 'The platform confirmed a processing failure' },
  {
    from: 'sending',
    to: 'outcome-unknown',
    when: 'Timeout, reset, unclassified error after send, or an expired lease',
  },
  { from: 'processing', to: 'outcome-unknown', when: "Processing exceeded the platform's maximum" },
  {
    from: 'outcome-unknown',
    to: 'published',
    when: 'Authoritative evidence, or a person confirms a candidate with its platformPostId',
  },
  {
    from: 'outcome-unknown',
    to: 'not-published',
    when: 'Authoritative evidence of absence, or a person rejects every candidate',
  },
  {
    from: 'blocked',
    to: 'scheduled',
    when: "A temporary reason's recheckAt passes, or resume reruns every check (no step attempted)",
    requires: 'no-receipt',
  },
  {
    from: 'blocked',
    to: 'processing',
    when: "resume reruns every check, or a temporary reason's recheckAt passes, for a variant with an attempted step",
    requires: 'receipt',
  },
  { from: 'blocked', to: 'cancelled', when: 'cancel, or 7 days after dueAt' },
  ...supersedable.map((from): VariantTransition => ({
    from,
    to: 'superseded',
    when: 'A new revision copies the variant',
    requires: 'no-receipt',
  })),
  ...nonFinal.map((from): VariantTransition => ({
    from,
    to: 'cancelled',
    when: 'Disconnect or channel removal',
    requires: 'no-receipt',
  })),
];

export type TransitionContext = { readonly hasReceipt: boolean };

/** Whether any listed transition from `from` to `to` holds for this variant. */
export function canTransition(from: VariantState, to: VariantState, context: TransitionContext): boolean {
  return variantTransitions.some(
    transition =>
      transition.from === from &&
      transition.to === to &&
      (transition.requires === undefined || (transition.requires === 'receipt') === context.hasReceipt),
  );
}
