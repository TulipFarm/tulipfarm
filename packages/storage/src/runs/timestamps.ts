/** Shared timestamp coercion for Run, State, Attempt, and Lineage row mappers. */
export function timestamp(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

export function optionalTimestamp(value: string | Date | null): string | null {
  return value === null ? null : timestamp(value);
}
