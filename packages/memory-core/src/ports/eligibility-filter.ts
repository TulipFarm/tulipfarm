export interface EligibilityFilter<Selection, Predicate> {
  predicate(selection: Selection): Predicate;
}
