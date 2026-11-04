export type PlanStampTone = 'draft' | 'approved' | 'changed';
export type PlanStamp = { tone: PlanStampTone; text: string };

export type PlanStampInput = {
  approval?: { approverName: string; approvedAt: string | Date } | undefined;
  contentRevision: number;
  /** The revision the approval covers. Without it, the approval covers `contentRevision`. */
  approvedRevision?: number | undefined;
  /** IANA zone for the approval time; an unknown zone falls back to UTC. */
  timeZone: string;
};

const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function zone(timeZone: string): string {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone });
    return timeZone;
  } catch {
    return 'UTC';
  }
}

function zoneName(date: Date, timeZone: string): string {
  // en-GB names European zones (BST, CEST) and en-US American ones (EDT); each gives GMT±n for the other's.
  const names = ['en-GB', 'en-US'].map(
    locale =>
      new Intl.DateTimeFormat(locale, { timeZone, timeZoneName: 'short' })
        .formatToParts(date)
        .find(part => part.type === 'timeZoneName')?.value ?? 'UTC',
  );
  return names.find(name => !/^(?:GMT|UTC)[+-]/.test(name)) ?? names[0] ?? 'UTC';
}

/** `d MMM yyyy, HH:mm ZONE` in the given zone, such as `14 Sep 2026, 09:05 BST`. */
export function formatDateTime(value: string | Date, timeZone: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'an unknown time';
  const resolved = zone(timeZone);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: resolved,
      day: 'numeric',
      month: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(date)
      .map(part => [part.type, part.value]),
  );
  const month = months[Number(parts.month) - 1] ?? '';
  return `${Number(parts.day)} ${month} ${parts.year}, ${parts.hour}:${parts.minute} ${zoneName(date, resolved)}`;
}

/** `d MMM yyyy` in the given zone. */
export function formatDate(value: string | Date, timeZone: string): string {
  const full = formatDateTime(value, timeZone);
  return full.split(',')[0] ?? full;
}

export function planStamp(input: PlanStampInput): PlanStamp {
  if (!input.approval) return { tone: 'draft', text: 'Draft, not approved' };
  const approved = input.approvedRevision ?? input.contentRevision;
  if (approved !== input.contentRevision)
    return {
      tone: 'changed',
      text: `Revision ${input.contentRevision}, changed since revision ${approved} was approved`,
    };
  const { approverName, approvedAt } = input.approval;
  const known = !Number.isNaN(new Date(approvedAt).getTime());
  return {
    tone: 'approved',
    text: `Revision ${approved} approved by ${approverName}${known ? `, ${formatDateTime(approvedAt, input.timeZone)}` : ''}`,
  };
}

export function stampText(input: PlanStampInput): string {
  return planStamp(input).text;
}
