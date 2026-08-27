/* User principal ids equal `users.id::text`; non-user principals must still render honestly. */

import type { UserStatus } from "./api";
import type { UserSummary } from "./users";

export type Party = {
  principalId: string;
  /** What to show first. A name when we have one, else the email, else the raw id. */
  name: string;
  /** The supporting line: an email for a person, a kind for anything else. */
  detail: string;
  /** Up to two letters for the avatar. */
  initials: string;
  isPerson: boolean;
  status?: UserStatus;
};

export type Directory = ReadonlyMap<string, Party>;

export function buildDirectory(users: readonly UserSummary[]): Directory {
  return new Map(users.map((user) => [user.id, personParty(user)]));
}

function personParty(user: UserSummary): Party {
  const name = user.name?.trim();
  return {
    principalId: user.id,
    name: name && name.length > 0 ? name : user.email,
    detail: user.email,
    initials: initialsFor(name && name.length > 0 ? name : user.email),
    isPerson: true,
    status: user.status,
  };
}

/** Unknown ids keep their raw `principalId` for copy/support while `name` stays readable. */
export function lookupParty(directory: Directory, principalId: string): Party {
  const known = directory.get(principalId);
  if (known) return known;

  const [prefix, ...rest] = principalId.split(":");
  if (rest.length > 0 && prefix) {
    const tail = rest.join(":");
    return {
      principalId,
      name: humanize(tail),
      detail: `${humanize(prefix)}, not a person`,
      initials: initialsFor(tail),
      isPerson: false,
    };
  }

  return {
    principalId,
    name: shortenId(principalId),
    detail: "Not a person in this business",
    initials: initialsFor(principalId),
    isPerson: false,
  };
}

/** Case-insensitive match across name and email, for the people search box. */
export function matchesQuery(party: Party, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return true;
  return (
    party.name.toLowerCase().includes(needle) ||
    party.detail.toLowerCase().includes(needle) ||
    party.principalId.toLowerCase().includes(needle)
  );
}

function initialsFor(value: string): string {
  const words = value
    .replaceAll(/[._:@-]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0);

  if (words.length === 0) return "?";
  if (words.length === 1) return (words[0] ?? "").slice(0, 2).toUpperCase();
  return `${(words[0] ?? "").charAt(0)}${(words[1] ?? "").charAt(0)}`.toUpperCase();
}

/** A UUID is unreadable in full and no more readable truncated in the middle. Keep the head. */
function shortenId(value: string): string {
  return value.length > 12 ? `${value.slice(0, 8)}…` : value;
}

function humanize(value: string): string {
  const words = value.replaceAll(/[._-]+/g, " ").trim();
  if (words.length === 0) return value;
  return words.charAt(0).toUpperCase() + words.slice(1);
}
