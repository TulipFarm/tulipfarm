const gmailDomains = new Set(['gmail.com', 'googlemail.com']);

/**
 * Dedupe key for an email address. Keep the typed address for delivery.
 * Gmail ignores dots and `+tag` in the local part and treats googlemail.com as gmail.com.
 * Other providers do not guarantee either alias rule, so they are only lowercased.
 */
export function canonicalEmail(address: string) {
  const email = address.trim().toLowerCase();
  const [local = '', domain = ''] = email.split('@');
  if (!gmailDomains.has(domain)) return email;
  const name = local.split('+')[0]!.replaceAll('.', '');
  return name ? `${name}@gmail.com` : email;
}

/** SQL form of canonicalEmail for a column holding a trimmed, lowercased address. Keep both forms in step. */
export function canonicalEmailSql(column: string) {
  return (
    `CASE WHEN split_part(${column}, '@', 2) IN ('gmail.com', 'googlemail.com') AND replace(split_part(split_part(${column}, '@', 1), '+', 1), '.', '') <> ''` +
    ` THEN replace(split_part(split_part(${column}, '@', 1), '+', 1), '.', '') || '@gmail.com' ELSE ${column} END`
  );
}
