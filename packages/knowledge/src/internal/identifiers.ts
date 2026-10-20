export const normalizeIdentifier = (value: string) => value.normalize('NFKC').toLowerCase();

export function exactIdentifiers(value: string) {
  return [
    ...new Set(
      (value.match(/[\p{L}\p{N}_:/?&=#.%+@\\-]+/gu) ?? [])
        .filter(word => word.length <= 512 && /[\d_:/?&=#.%+@\\-]/u.test(word))
        .flatMap(word => [normalizeIdentifier(word), normalizeIdentifier(word.replace(/\.+$/, ''))])
        .filter(Boolean),
    ),
  ];
}
