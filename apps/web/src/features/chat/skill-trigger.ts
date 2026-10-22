export function skillAt(text: string, caret: number) {
  const match = /(?:^|\s)\/((?:[^\s/@][^\n/@]{0,79})?)$/u.exec(text.slice(0, caret));
  const query = match?.[1];
  return query === undefined ? null : { start: caret - query.length - 1, end: caret, query };
}
